/**
 * Translates an OpenCode session into this app's NDJSON stream.
 *
 * OpenCode and the Anthropic streaming format describe the same conversation in
 * different shapes, and this module is where one becomes the other. The
 * important difference is *cumulative vs incremental*: `message.part.updated`
 * carries the entire part every time it changes, with an optional `delta`,
 * whereas the client here was built for `content_block_delta` and expects only
 * what is new. So each part's last-emitted length is tracked and only the tail
 * is sent — using `delta` when OpenCode provides one and falling back to a
 * suffix diff when it does not.
 *
 * Everything else is bookkeeping around that: parts arrive interleaved and
 * identified only by id, so open text/reasoning blocks are closed on transition
 * rather than on any explicit stop event, and tool calls are matched to their
 * results by `callID`.
 *
 * The module owns no persistence and no HTTP. It emits `StreamEvent`s and hands
 * back the assembled `ContentBlock[]`, which is what lets the caller store an
 * OpenCode turn in exactly the same shape as an Agent SDK one.
 */

import type { Event, OpencodeClient, Part } from '@opencode-ai/sdk';
import type { StreamEvent } from '@/lib/streamEvents';
import type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '@/lib/types';
import { getContextWindow, type ModelId } from '@/lib/models';
import { augmentToolInput } from '@/server/toolInputAugment';
import { promptModel } from './providers';
import { toUiToolInput, toUiToolName } from './toolMapping';

function newBlockId(): string {
  return `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type TurnInput = {
  prompt: string;
  /** Data-URL images to attach, in the order the user added them. */
  images?: { dataUrl: string; mediaType: string; name?: string }[];
};

export type RunnerOptions = {
  client: OpencodeClient;
  /** OpenCode session this stream is bound to. */
  sessionId: string;
  /** Working directory for tool execution. */
  directory: string;
  model: ModelId;
  /** Fully-assembled system prompt, sent with every turn. */
  system: string;
  /** MCP servers published for this stream, for tool-name mapping. */
  mcpServerNames: string[];
  /**
   * Tools to withhold. Names are OpenCode's own (`bash`, `read`), matching what
   * `session.prompt`'s `tools` map keys on.
   */
  disabledTools?: string[];
  /** Directory used to snapshot pre-edit file contents for diff rendering. */
  diffCwd: string;
  env: NodeJS.ProcessEnv;
  send: (event: StreamEvent) => void;
};

export type TurnResult = {
  blocks: ContentBlock[];
  /** Set when the turn ended in an error rather than normally. */
  error: string | null;
};

/** Per-part streaming bookkeeping. */
type PartCursor = {
  kind: 'text' | 'reasoning';
  blockId: string;
  /** Characters already emitted, so re-sent cumulative text is not duplicated. */
  emitted: number;
};

export type OpencodeRunner = {
  /** Run one turn to completion and return its assembled blocks. */
  runTurn: (turn: TurnInput) => Promise<TurnResult>;
  /** Ask OpenCode to stop the in-flight turn. */
  abort: () => Promise<void>;
  /** Stop consuming events. Does not stop the server — the caller owns that. */
  dispose: () => void;
};

/**
 * Attach to a session's event stream and return a turn runner.
 *
 * The subscription is opened once and spans every turn on the stream, which is
 * what makes mid-conversation injection work: a second turn reuses the same
 * connection rather than racing to re-subscribe.
 */
export async function startOpencodeRunner(
  opts: RunnerOptions,
): Promise<OpencodeRunner> {
  const { client, sessionId, send } = opts;
  const contextWindow = getContextWindow(opts.model);

  // ===== State shared across turns =====
  let disposed = false;
  /** Resolves the in-flight turn once OpenCode reports the session idle. */
  let settleTurn: ((error: string | null) => void) | null = null;

  // ===== Per-turn state, reset by `resetTurn` =====
  let blocks: ContentBlock[] = [];
  let cursors = new Map<string, PartCursor>();
  let tools = new Map<
    string,
    { blockId: string; uiName: string; settled: boolean }
  >();
  /** Part id of the currently-open text/reasoning block, if any. */
  let openTextPart: string | null = null;
  let openThinkingPart: string | null = null;
  let tokensUsed = 0;

  /**
   * Role of each message OpenCode has announced on this session.
   *
   * The prompt's own user message is echoed back as parts, and replaying it as
   * assistant output would duplicate what the client already rendered. Message
   * ids are minted by OpenCode in its own format, so they cannot be predicted —
   * the role is learned from `message.updated`, which is emitted before the
   * message's parts because the parts reference it.
   *
   * Kept across turns rather than reset: a late part from a settled turn should
   * still resolve to the right role, and the map only ever holds one entry per
   * message in the session.
   */
  const messageRoles = new Map<string, 'user' | 'assistant'>();

  /**
   * Publish a token reading to the context meter.
   *
   * The meter shows the CONTEXT FOOTPRINT of one model call — how full the
   * window is — not cumulative spend across the turn. Summing every step of a
   * function-calling loop is what produces the nonsense "1.4M used" readings
   * the Agent SDK path documents at length; each step already reports the whole
   * conversation it was sent, so the newest step is the current footprint and
   * earlier ones are subsets of it.
   *
   * Cache tokens are the part that must not be dropped. With prompt caching,
   * `input` counts only the uncached tail — on a long conversation nearly the
   * entire context arrives as `cache.read`, so adding just input + output read
   * a small fraction of the truth and the meter barely moved.
   *
   * `reasoning` is deliberately excluded: it is a breakdown OF `output`, not an
   * addition to it, so including it double-counts thinking tokens.
   *
   * This mirrors `usageTotal` on the Agent SDK path exactly (input + output +
   * cache read + cache write), so the gauge means the same thing on both.
   */
  function reportUsage(tokens: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  }) {
    const footprint =
      (tokens.input || 0) +
      (tokens.output || 0) +
      (tokens.cache?.read || 0) +
      (tokens.cache?.write || 0);
    // Skip empty and repeated readings — a step that reports nothing must not
    // reset a meter that already has a real number on it.
    if (footprint <= 0 || footprint === tokensUsed) return;
    tokensUsed = footprint;
    send({
      type: 'token_budget',
      used: footprint,
      total: contextWindow,
      // Same split the Agent SDK path publishes, so a credit estimate reads
      // identically on both backends.
      split: {
        input: tokens.input || 0,
        cached: (tokens.cache?.read || 0) + (tokens.cache?.write || 0),
        output: tokens.output || 0,
      },
    });
  }

  function resetTurn() {
    blocks = [];
    cursors = new Map();
    tools = new Map();
    openTextPart = null;
    openThinkingPart = null;
  }

  /**
   * Close whichever inline block is open.
   *
   * OpenCode has no per-part stop event, so a block stays open until something
   * else starts. Without this the UI leaves a blinking cursor on the last text
   * block of every turn.
   */
  function closeOpenBlocks() {
    if (openTextPart) {
      const cursor = cursors.get(openTextPart);
      const block = blocks.find(
        (b): b is TextBlock => b.type === 'text' && b.id === cursor?.blockId,
      );
      if (block) block.streaming = false;
      send({ type: 'text_stop' });
      openTextPart = null;
    }
    if (openThinkingPart) {
      const cursor = cursors.get(openThinkingPart);
      const block = blocks.find(
        (b): b is ThinkingBlock =>
          b.type === 'thinking' && b.id === cursor?.blockId,
      );
      if (block) block.streaming = false;
      send({ type: 'thinking_stop' });
      openThinkingPart = null;
    }
  }

  /** Handle a text or reasoning part update, emitting only the new tail. */
  function handleInlinePart(
    part: Extract<Part, { type: 'text' | 'reasoning' }>,
    delta: string | undefined,
  ) {
    const kind = part.type;
    const full = part.text ?? '';
    let cursor = cursors.get(part.id);

    if (!cursor) {
      // OpenCode announces a part before the model has written anything into
      // it, and opening a block here would leave an empty bubble in the
      // transcript whenever a turn goes straight to a tool call. Wait for real
      // content before committing to a block.
      if (!full) return;
      closeOpenBlocks();
      const blockId = newBlockId();
      cursor = { kind, blockId, emitted: 0 };
      cursors.set(part.id, cursor);
      if (kind === 'text') {
        blocks.push({ type: 'text', id: blockId, text: '', streaming: true });
        openTextPart = part.id;
        send({ type: 'text_start' });
      } else {
        blocks.push({ type: 'thinking', id: blockId, text: '', streaming: true });
        openThinkingPart = part.id;
        send({ type: 'thinking_start' });
      }
    }

    // Prefer OpenCode's own delta, but only when it lines up with what we have
    // already emitted — on a reconnect or replay the cumulative text is
    // authoritative and the delta would double up.
    const chunk =
      delta !== undefined && full.length === cursor.emitted + delta.length
        ? delta
        : full.slice(cursor.emitted);
    if (!chunk) return;
    cursor.emitted = full.length;

    const block = blocks.find((b) => b.id === cursor.blockId);
    if (block && (block.type === 'text' || block.type === 'thinking')) {
      block.text = full;
    }
    send(
      kind === 'text'
        ? { type: 'text_delta', text: chunk }
        : { type: 'thinking_delta', text: chunk },
    );
  }

  /** Handle a tool part through its pending → running → completed lifecycle. */
  function handleToolPart(part: Extract<Part, { type: 'tool' }>) {
    const uiName = toUiToolName(part.tool, opts.mcpServerNames);
    let entry = tools.get(part.callID);

    if (!entry) {
      closeOpenBlocks();
      const blockId = newBlockId();
      entry = { blockId, uiName, settled: false };
      tools.set(part.callID, entry);
      blocks.push({
        type: 'tool_use',
        id: blockId,
        toolUseId: part.callID,
        name: uiName,
        input: {},
        streaming: true,
      });
      send({ type: 'tool_use_start', toolUseId: part.callID, name: uiName });
    }

    const block = blocks.find(
      (b): b is ToolUseBlock => b.type === 'tool_use' && b.id === entry.blockId,
    );
    const state = part.state;

    // Every state except `pending` carries the resolved input. `error` is
    // included deliberately: a tool that fails without ever reaching `running`
    // would otherwise never have its card filled in, and would keep rendering
    // as in-flight even with its failure attached.
    if (state.status !== 'pending') {
      const input = augmentToolInput(
        uiName,
        toUiToolInput(uiName, state.input),
        opts.diffCwd,
      );
      if (block && block.streaming) {
        block.input = input;
        block.streaming = false;
        // `tool_use_input`, NOT `tool_use`. The client treats them differently:
        // `tool_use_input` fills in the card already opened by
        // `tool_use_start`, while `tool_use` PUSHES a brand-new card and is
        // only correct when no start was sent. Sending the latter here
        // produced two cards per call — the original stuck at streaming:true,
        // and a duplicate that never received a result — so every tool
        // appeared to run forever even though its result had arrived.
        send({
          type: 'tool_use_input',
          toolUseId: part.callID,
          name: uiName,
          input,
        });
      }
    }

    // A settled tool can be re-announced (part updates are cumulative, and
    // metadata can change after the fact). Emit its result exactly once so the
    // transcript isn't rewritten and re-flushed on every echo.
    if (entry.settled) return;

    if (state.status === 'completed') {
      entry.settled = true;
      if (block) block.result = { content: state.output, isError: false };
      send({
        type: 'tool_result',
        toolUseId: part.callID,
        content: state.output,
        isError: false,
      });
    } else if (state.status === 'error') {
      entry.settled = true;
      if (block) {
        block.streaming = false;
        block.result = { content: state.error, isError: true };
      }
      send({
        type: 'tool_result',
        toolUseId: part.callID,
        content: state.error,
        isError: true,
      });
    }
  }

  function handleEvent(event: Event) {
    switch (event.type) {
      case 'message.updated': {
        const info = event.properties.info;
        if (info.sessionID !== sessionId) return;
        messageRoles.set(info.id, info.role);
        return;
      }
      case 'message.part.updated': {
        const { part, delta } = event.properties;
        if (part.sessionID !== sessionId) return;
        // The prompt's own user message is echoed back as parts; the client
        // already rendered it optimistically. Unknown roles are processed
        // rather than dropped — losing assistant output is far worse than
        // briefly double-rendering a prompt.
        if (messageRoles.get(part.messageID) === 'user') return;

        if (part.type === 'text' || part.type === 'reasoning') {
          handleInlinePart(part, delta);
        } else if (part.type === 'tool') {
          handleToolPart(part);
        } else if (part.type === 'step-finish') {
          reportUsage(part.tokens);
        }
        return;
      }
      case 'session.idle': {
        if (event.properties.sessionID !== sessionId) return;
        closeOpenBlocks();
        settleTurn?.(null);
        return;
      }
      case 'session.error': {
        if (event.properties.sessionID && event.properties.sessionID !== sessionId) {
          return;
        }
        closeOpenBlocks();
        const err = event.properties.error;
        const message =
          (err?.data as { message?: string } | undefined)?.message ??
          err?.name ??
          'OpenCode reported an error';
        settleTurn?.(message);
        return;
      }
      default:
        return;
    }
  }

  // Subscribe before any prompt is sent so no early delta is missed.
  const events = await client.event.subscribe();
  const pump = (async () => {
    try {
      for await (const event of events.stream) {
        if (disposed) break;
        handleEvent(event as Event);
      }
    } catch {
      // The stream ends when the server is torn down; that is the normal exit
      // path here, not a condition the turn needs to hear about.
    }
  })();
  // Nothing awaits the pump — it outlives each turn and ends with the server.
  void pump;

  return {
    async runTurn(turn: TurnInput): Promise<TurnResult> {
      resetTurn();

      const settled = new Promise<string | null>((resolve) => {
        settleTurn = resolve;
      });

      const parts: (
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; filename?: string; url: string }
      )[] = [];
      for (const image of turn.images ?? []) {
        parts.push({
          type: 'file',
          mime: image.mediaType,
          filename: image.name,
          url: image.dataUrl,
        });
      }
      if (turn.prompt) parts.push({ type: 'text', text: turn.prompt });
      // A prompt with no parts is rejected; an empty nudge is the closest
      // equivalent to the Agent SDK's no-op turn.
      if (parts.length === 0) parts.push({ type: 'text', text: '(continue)' });

      const toolToggles: Record<string, boolean> = {};
      for (const name of opts.disabledTools ?? []) toolToggles[name] = false;

      let promptError: string | null = null;
      try {
        const response = await client.session.prompt({
          path: { id: sessionId },
          query: { directory: opts.directory },
          body: {
            // `messageID` is deliberately not sent. OpenCode mints ids in its
            // own prefixed format and rejects anything else outright
            // (`Expected a string starting with "msg"`), so the user message id
            // is learned from `message.updated` instead of being dictated here.
            model: promptModel(opts.model, opts.env),
            system: opts.system,
            ...(Object.keys(toolToggles).length > 0
              ? { tools: toolToggles }
              : {}),
            parts,
          },
        });
        if (response.error) {
          promptError =
            (response.error as { data?: { message?: string } }).data?.message ??
            'OpenCode rejected the request';
        }
      } catch (err) {
        promptError = err instanceof Error ? err.message : String(err);
      }

      // `session.prompt` resolves when the turn is done, but the last few
      // part updates may still be in flight on the event stream. `session.idle`
      // is the authoritative end; race it against a short grace so a dropped
      // idle event cannot hang the turn forever.
      const idleError = promptError
        ? null
        : await Promise.race([
            settled,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
          ]);
      settleTurn = null;
      closeOpenBlocks();

      const error = promptError ?? idleError;
      return { blocks: [...blocks], error };
    },

    async abort() {
      try {
        await client.session.abort({ path: { id: sessionId } });
      } catch {
        // Already finished or already torn down — either way there is nothing
        // left to stop.
      }
    },

    dispose() {
      disposed = true;
      settleTurn = null;
    },
  };
}
