'use client';

import { useCallback, useEffect, useRef } from 'react';
import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  AssistantMessage,
  CompactBoundaryBlock,
  ContentBlock,
  ImageAttachmentBlock,
  ImageMediaType,
  QueuedMessage,
  SystemMessage,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  UserMessage,
} from '@/lib/types';
import type { EffortLevel, ModelId } from '@/lib/models';
import { useInstances } from '@/state/instances';
import { setPlanUsage, setRateLimitUsage } from '@/state/usage';

type StreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'stream_ready'; streamId: string }
  | {
      type: 'turn_started';
      turnIndex: number;
      userMessageId: string;
      assistantMessageId: string;
      prompt: string;
      images?: ImageAttachmentBlock[];
    }
  | { type: 'text_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'text_stop' }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_stop' }
  | { type: 'tool_use_start'; toolUseId: string; name: string }
  | { type: 'tool_use_input'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'awaiting_question'; toolUseId: string; input: unknown }
  | {
      type: 'question_answered';
      toolUseId: string;
      answers: Record<string, string>;
    }
  | { type: 'token_budget'; used: number; total: number }
  | {
      type: 'compact_boundary';
      messageId: string;
      trigger: 'manual' | 'auto';
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
    }
  | {
      type: 'refusal';
      model: string;
      category?: string | null;
      explanation?: string | null;
    }
  | {
      type: 'rate_limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      utilization?: number;
      rateLimitType?: string;
      resetsAt?: number;
      isUsingOverage?: boolean;
    }
  | {
      /** Structured /usage data — per-window percentages, epoch-ms resets. */
      type: 'usage';
      fiveHour?: { utilization: number | null; resetsAt: number | null } | null;
      sevenDay?: { utilization: number | null; resetsAt: number | null } | null;
      sevenDayOpus?: { utilization: number | null; resetsAt: number | null } | null;
      sevenDaySonnet?: { utilization: number | null; resetsAt: number | null } | null;
      extraUsage?: {
        isEnabled: boolean;
        utilization: number | null;
        usedCredits: number | null;
        monthlyLimit: number | null;
      } | null;
    }
  | { type: 'message_complete'; assistantMessageId: string }
  | { type: 'complete' }
  | { type: 'error'; error: string };

function parseAskUserQuestionInput(input: unknown): AskUserQuestionItem[] {
  if (!input || typeof input !== 'object') return [];
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.questions)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const q of r.questions) {
    if (!q || typeof q !== 'object') continue;
    const qr = q as Record<string, unknown>;
    const question = typeof qr.question === 'string' ? qr.question : '';
    if (!question) continue;
    const header = typeof qr.header === 'string' ? qr.header : undefined;
    const multiSelect = !!qr.multiSelect;
    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(qr.options)) {
      for (const o of qr.options) {
        if (!o || typeof o !== 'object') continue;
        const or = o as Record<string, unknown>;
        const label = typeof or.label === 'string' ? or.label : '';
        if (!label) continue;
        const opt: AskUserQuestionOption = { label };
        if (typeof or.description === 'string') opt.description = or.description;
        if (typeof or.preview === 'string') opt.preview = or.preview;
        options.push(opt);
      }
    }
    out.push({ question, header, options, multiSelect });
  }
  return out;
}

export type SendImage = {
  dataUrl: string;
  mediaType: ImageMediaType;
  name?: string;
};

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type SendOptions = {
  prompt: string;
  images?: SendImage[];
  /** When true, don't append a user message — used for /compact slash command. */
  compact?: boolean;
  /**
   * Optional caller-allocated IDs. When the streaming hook is replaying a
   * fallback (inject endpoint returned 410), the caller forwards the IDs the
   * inject was already going to use so the user message keeps its identity
   * end-to-end.
   */
  userMessageId?: string;
  assistantMessageId?: string;
  /**
   * One-shot effort override for THIS stream only. Used when the user accepts
   * an auto-effort suggestion: the chosen effort must reach the request body
   * synchronously, before the `modelOptsRef` useEffect has a chance to sync
   * the lifted preference. Falls back to the live preference when absent.
   */
  effort?: EffortLevel;
};

type ModelOptions = {
  /** Current model selection — passed to /api/chat on every new stream. */
  model?: ModelId;
  /** Current effort ("thinking power") — passed straight to the SDK's `effort`. */
  effort?: EffortLevel;
};

export function useStreamingChat(modelOpts: ModelOptions = {}) {
  const {
    stateRef,
    patch,
    appendMessage,
    updateMessage,
    enqueueMessage,
    removeQueuedMessage,
  } = useInstances();
  const aborterRef = useRef<AbortController | null>(null);
  /**
   * Live snapshot of the current model+thinking preference. Stored in a ref so
   * the long-lived `runStream` closure (and the fallback-drain recursion at
   * the end of it) always read the LATEST selection — not the one captured
   * when the hook last re-rendered. The user can change picks while a stream
   * is alive; the new stream that drains a queued message picks them up.
   */
  const modelOptsRef = useRef<ModelOptions>(modelOpts);
  useEffect(() => {
    modelOptsRef.current = modelOpts;
  }, [modelOpts]);
  /**
   * Synchronous gate so two `runStream` calls can't open parallel SDK queries
   * against the same session — both would `resume:` the same JSONL transcript
   * and clobber each other. React's `streaming` prop only flips on the next
   * commit, so without this ref a rapid double-Enter slips through the
   * Composer's streaming check.
   */
  const streamInFlightRef = useRef(false);
  /**
   * Tracks the currently-live SDK stream for the active instance. Mid-loop
   * injects use `streamId` here to address the right server-side query.
   * Cleared when the stream finishes or aborts.
   */
  const liveStreamRef = useRef<{
    instanceId: string;
    streamId: string | null;
  } | null>(null);
  /**
   * userMessageIds of queued messages that have already been successfully
   * POSTed to /api/chat/inject. We track them in a ref (not in React state)
   * so a racing second caller — say the stream_ready drain and a fresh
   * `queue()` call colliding on the same entry — can't double-send. The id
   * is cleared the moment `turn_started` lands so the queue→chat handoff is
   * the source of truth for "this message has been delivered."
   */
  const injectedRef = useRef<Set<string>>(new Set());
  /**
   * Set by the live `runStream` so out-of-closure callers (`queue()`, the
   * in-flight redirect) can split the streaming assistant message the
   * moment a user bubble lands mid-loop. Without the split, the loop keeps
   * appending blocks to the assistant message ABOVE the user bubble and
   * pushes it ever further down — the canvas loses chronology. Splitting
   * closes the current assistant message and routes every block that
   * arrives after the user's message into a fresh assistant message BELOW
   * it. Cleared when the stream ends.
   */
  const turnSplitRef = useRef<((instanceId: string) => void) | null>(null);

  /**
   * Append a user message to the active conversation, but only if a message
   * with the same id isn't already there. This is the dedupe gate used by
   * every code path that optimistically lands a user bubble in the chat —
   * `queue()`, the in-flight branch of `runStream()`, the normal first-turn
   * optimistic append, and the fallback drain after a stream closes early.
   * Without it, the fallback drain would double-append a message that
   * `queue()` already put in the canvas.
   */
  const appendUserMessageIfAbsent = useCallback(
    (
      instanceId: string,
      userMessageId: string,
      text: string,
      images: SendImage[] | undefined,
    ) => {
      const inst = stateRef.current.instances.find((i) => i.id === instanceId);
      if (!inst) return;
      if (inst.messages.some((m) => m.id === userMessageId)) return;
      const imageBlocks: ImageAttachmentBlock[] | undefined = images?.map(
        (img) => ({
          type: 'image' as const,
          id: newId('img'),
          dataUrl: img.dataUrl,
          mediaType: img.mediaType,
          name: img.name,
        }),
      );
      const userMsg: UserMessage = {
        id: userMessageId,
        role: 'user',
        text,
        images: imageBlocks,
        createdAt: Date.now(),
      };
      appendMessage(instanceId, userMsg);
    },
    [stateRef, appendMessage],
  );

  /**
   * Mid-loop inject: push a queued user message into the running SDK query
   * so the model picks it up at the next turn boundary. The message stays
   * in the per-instance queue UI until the server's `turn_started` event
   * promotes it into the chat history — that way the user can still see
   * and cancel pending messages while the model is busy.
   *
   * Returns true if the inject was accepted by the server. False means the
   * stream just closed (race) and the caller should fall back to opening
   * a brand-new chat stream for the message.
   */
  const injectMessage = useCallback(
    async (
      queued: QueuedMessage,
      images: SendImage[] | undefined,
    ): Promise<boolean> => {
      if (injectedRef.current.has(queued.userMessageId)) return true;
      const inst = stateRef.current.instances.find(
        (i) => i.id === stateRef.current.activeId,
      );
      if (!inst) return false;
      const live = liveStreamRef.current;
      if (!live || live.instanceId !== inst.id || !live.streamId) return false;
      // Mark before awaiting so a concurrent caller (e.g. the stream_ready
      // drain firing while this POST is still in flight) bails out instead
      // of double-injecting the same message.
      injectedRef.current.add(queued.userMessageId);
      try {
        const res = await fetch('/api/chat/inject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            streamId: live.streamId,
            prompt: queued.text,
            userMessageId: queued.userMessageId,
            assistantMessageId: queued.assistantMessageId,
            images,
          }),
        });
        if (res.ok) return true;
        injectedRef.current.delete(queued.userMessageId);
        return false;
      } catch {
        injectedRef.current.delete(queued.userMessageId);
        return false;
      }
    },
    [stateRef],
  );

  /**
   * Open a brand-new chat stream for an instance. Used for the first user
   * message and for fallback when an inject is rejected (stream just closed).
   */
  const runStream = useCallback(
    async (opts: SendOptions) => {
      const { prompt, images, compact } = opts;
      const trimmed = prompt.trim();
      if (!trimmed && !compact) return;

      const inst = stateRef.current.instances.find(
        (i) => i.id === stateRef.current.activeId,
      );
      if (!inst || !inst.cwd) return;
      if (compact && !inst.sessionId) return; // /compact only valid mid-conversation

      // A second stream while the first is still alive would double-resume
      // the same session and corrupt the transcript. Redirect into the
      // mid-loop queue/inject path instead so the message still gets sent
      // — just through the running stream rather than a parallel one.
      if (streamInFlightRef.current) {
        if (!compact) {
          const qUserId = opts.userMessageId ?? newId('user');
          const qAsstId = opts.assistantMessageId ?? newId('asst');
          const queueMsg: QueuedMessage = {
            id: newId('q'),
            userMessageId: qUserId,
            assistantMessageId: qAsstId,
            text: trimmed,
            images: images?.map((img) => ({
              id: newId('img'),
              dataUrl: img.dataUrl,
              mediaType: img.mediaType,
              name: img.name,
            })),
            createdAt: Date.now(),
          };
          // Drop the user message into the conversation canvas right now —
          // the user can see their input land in the chat as soon as they
          // hit Send, even mid-loop. The server's later `turn_started`
          // event dedupes on `userMessageId` (see `alreadyInChat`) so we
          // never double-append when the SDK actually picks it up.
          appendUserMessageIfAbsent(inst.id, qUserId, trimmed, images);
          // Keep the canvas chronological: close the streaming assistant
          // message so post-send blocks land BELOW this user bubble.
          turnSplitRef.current?.(inst.id);
          enqueueMessage(inst.id, queueMsg);
          void injectMessage(queueMsg, images);
        }
        return;
      }
      streamInFlightRef.current = true;

      const instId = inst.id;
      const userMessageId = opts.userMessageId ?? newId('user');
      const assistantId = opts.assistantMessageId ?? newId('asst');

      // Optimistic local append for the FIRST user message in this stream —
      // matches the existing UX (the user sees their message as soon as they
      // hit send, before the server has acknowledged anything). Subsequent
      // turn_started events that arrive WITHIN this stream are mid-loop
      // injects — they're handled via the queue→chat handoff below. The
      // idempotent helper covers the fallback-drain case where `queue()`
      // already landed this same id in the canvas.
      if (!compact) {
        appendUserMessageIfAbsent(instId, userMessageId, trimmed, images);
      }
      patch(instId, {
        streaming: true,
        streamingMessageId: null,
        compacting: !!compact,
      });

      // ===== Per-turn state — `let` because it rolls forward on turn_started. =====
      let activeAssistantId: string | null = null;
      let blocks: ContentBlock[] = [];
      let currentTextId: string | null = null;
      let currentThinkingId: string | null = null;
      let assistantStartedForActiveTurn = false;

      const closeStreamingInline = () => {
        if (currentTextId) {
          const id = currentTextId;
          const idx = blocks.findIndex(
            (b) => b.type === 'text' && b.id === id,
          );
          if (idx >= 0) {
            const orig = blocks[idx] as TextBlock;
            if (orig.streaming) blocks[idx] = { ...orig, streaming: false };
          }
          currentTextId = null;
        }
        if (currentThinkingId) {
          const id = currentThinkingId;
          const idx = blocks.findIndex(
            (b) => b.type === 'thinking' && b.id === id,
          );
          if (idx >= 0) {
            const orig = blocks[idx] as ThinkingBlock;
            if (orig.streaming) blocks[idx] = { ...orig, streaming: false };
          }
          currentThinkingId = null;
        }
      };

      const ensureAssistantForActiveTurn = () => {
        if (assistantStartedForActiveTurn) return;
        if (!activeAssistantId) return;
        assistantStartedForActiveTurn = true;
        const msg: AssistantMessage = {
          id: activeAssistantId,
          role: 'assistant',
          blocks: [],
          createdAt: Date.now(),
          streaming: true,
        };
        appendMessage(instId, msg);
        patch(instId, { streamingMessageId: activeAssistantId });
      };

      let pendingFlushHandle: number | null = null;
      const flushNow = () => {
        if (!activeAssistantId) return;
        if (!assistantStartedForActiveTurn) return;
        const id = activeAssistantId;
        updateMessage(instId, id, { blocks: [...blocks] } as Partial<AssistantMessage>);
      };
      const flush = () => {
        if (pendingFlushHandle != null) return;
        if (typeof requestAnimationFrame !== 'undefined') {
          pendingFlushHandle = requestAnimationFrame(() => {
            pendingFlushHandle = null;
            flushNow();
          });
        } else {
          flushNow();
        }
      };
      const cancelPendingFlush = () => {
        if (pendingFlushHandle != null && typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(pendingFlushHandle);
        }
        pendingFlushHandle = null;
      };

      /**
       * Finalize whichever assistant turn we were just streaming so its
       * blocks land in state with `streaming: false`. Safe to call when no
       * turn is active — it's a no-op in that case.
       */
      const finalizeActiveTurn = () => {
        cancelPendingFlush();
        if (!activeAssistantId) return;
        if (!assistantStartedForActiveTurn) {
          activeAssistantId = null;
          return;
        }
        const id = activeAssistantId;
        updateMessage(instId, id, {
          streaming: false,
          blocks: blocks.map((b) =>
            b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use'
              ? { ...b, streaming: false }
              : b,
          ),
        } as Partial<AssistantMessage>);
        activeAssistantId = null;
        assistantStartedForActiveTurn = false;
      };

      /**
       * Assistant messages finalized early by a mid-loop user-message split.
       * Tools that were still running when the split happened resolve AFTER
       * it — their tool_result / late input events look the block up here
       * and patch the already-finalized message via updateMessage, so no
       * tool card is ever left hanging without its result.
       */
      const splitSegments: { msgId: string; blocks: ContentBlock[] }[] = [];

      const patchToolBlockInSplitSegments = (
        toolUseId: string,
        patchBlock: (orig: ToolUseBlock) => ToolUseBlock,
      ): boolean => {
        for (const seg of splitSegments) {
          const idx = seg.blocks.findIndex(
            (b) => b.type === 'tool_use' && b.toolUseId === toolUseId,
          );
          if (idx >= 0) {
            seg.blocks[idx] = patchBlock(seg.blocks[idx] as ToolUseBlock);
            updateMessage(instId, seg.msgId, {
              blocks: [...seg.blocks],
            } as Partial<AssistantMessage>);
            return true;
          }
        }
        return false;
      };

      /**
       * Mid-loop user message just landed in the canvas (after the streaming
       * assistant message). Close the current assistant message so blocks
       * that arrive AFTER the user's message render in a new assistant
       * message BELOW the bubble — the canvas stays chronological instead
       * of the loop growing above the bubble and pushing it down.
       */
      const splitTurnForInjectedUser = (instanceId: string) => {
        if (instanceId !== instId) return;
        if (!activeAssistantId || !assistantStartedForActiveTurn) return;
        if (blocks.length === 0) return;
        // Keep the finalized (streaming:false) copies — a later tool_result
        // patch must not resurrect a streaming cursor in the closed message.
        splitSegments.push({
          msgId: activeAssistantId,
          blocks: blocks.map((b) =>
            b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use'
              ? { ...b, streaming: false }
              : b,
          ),
        });
        finalizeActiveTurn();
        blocks = [];
        currentTextId = null;
        currentThinkingId = null;
        // Synthetic continuation id — the next block event lazily appends a
        // fresh assistant message after the user bubble. The server's later
        // turn_started simply rolls past it like any finished turn.
        activeAssistantId = newId('asst');
        assistantStartedForActiveTurn = false;
      };
      turnSplitRef.current = splitTurnForInjectedUser;

      const ac = new AbortController();
      aborterRef.current = ac;
      liveStreamRef.current = { instanceId: instId, streamId: null };

      try {
        const { model, effort: liveEffort } = modelOptsRef.current;
        // A per-stream override (accepted auto-effort suggestion) wins over the
        // live preference so the request uses exactly what the user agreed to.
        const effort = opts.effort ?? liveEffort;
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: trimmed,
            cwd: inst.cwd,
            mode: inst.mode,
            sessionId: inst.sessionId,
            userMessageId,
            assistantMessageId: assistantId,
            images,
            compact,
            model,
            effort,
          }),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => 'request failed');
          if (!compact) {
            // Surface the error against the optimistically-appended assistant
            // skeleton. If one doesn't exist yet (unusual — body unavailable
            // immediately), create one so the error has a home.
            activeAssistantId = assistantId;
            ensureAssistantForActiveTurn();
            blocks.push({ type: 'error', id: newId('blk'), text: `Error: ${errText}` });
            flush();
          }
          patch(instId, {
            streaming: false,
            streamingMessageId: null,
            compacting: false,
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }

            switch (event.type) {
              case 'session': {
                patch(instId, { sessionId: event.sessionId });
                break;
              }
              case 'stream_ready': {
                if (liveStreamRef.current?.instanceId === instId) {
                  liveStreamRef.current.streamId = event.streamId;
                }
                // Catch-up: any messages the user enqueued in the narrow
                // window between `runStream` opening and this event landing
                // wouldn't have had a streamId to target. Inject them now,
                // FIFO. The dedupe-by-id inside `injectMessage` keeps a
                // racing `queue()` call from double-sending.
                {
                  const cur = stateRef.current.instances.find(
                    (i) => i.id === instId,
                  );
                  if (cur && cur.queuedMessages.length > 0) {
                    for (const q of cur.queuedMessages) {
                      const sendImages = q.images?.map((img) => ({
                        dataUrl: img.dataUrl,
                        mediaType: img.mediaType,
                        name: img.name,
                      }));
                      void injectMessage(q, sendImages);
                    }
                  }
                }
                break;
              }
              case 'turn_started': {
                // Roll the previous turn shut.
                finalizeActiveTurn();
                blocks = [];
                currentTextId = null;
                currentThinkingId = null;
                activeAssistantId = event.assistantMessageId;
                assistantStartedForActiveTurn = false;

                // Server has officially picked up this user message — drop
                // it from the inject-dedupe set, since the queue→chat
                // handoff below is the new source of truth.
                injectedRef.current.delete(event.userMessageId);

                // Promote any matching queued message into the real chat
                // history. If the user message already exists (turn 0, where
                // we optimistically appended on send), this is a no-op.
                const liveInst = stateRef.current.instances.find(
                  (i) => i.id === instId,
                );
                const alreadyInChat = !!liveInst?.messages.some(
                  (m) => m.id === event.userMessageId,
                );
                const queueMatch = liveInst?.queuedMessages.find(
                  (q) => q.userMessageId === event.userMessageId,
                );
                if (queueMatch) {
                  removeQueuedMessage(instId, queueMatch.id);
                }
                if (!alreadyInChat) {
                  const userMsg: UserMessage = {
                    id: event.userMessageId,
                    role: 'user',
                    text: event.prompt,
                    images:
                      event.images && event.images.length > 0
                        ? event.images
                        : undefined,
                    createdAt: Date.now(),
                  };
                  appendMessage(instId, userMsg);
                }
                // Append the empty assistant skeleton right away so the
                // "Working..." indicator has a home and the streaming
                // animation feels immediate.
                ensureAssistantForActiveTurn();
                break;
              }
              case 'text_start': {
                ensureAssistantForActiveTurn();
                currentTextId = newId('blk');
                blocks.push({
                  type: 'text',
                  id: currentTextId,
                  text: '',
                  streaming: true,
                });
                flush();
                break;
              }
              case 'text_delta': {
                ensureAssistantForActiveTurn();
                if (!currentTextId) {
                  currentTextId = newId('blk');
                  blocks.push({
                    type: 'text',
                    id: currentTextId,
                    text: event.text,
                    streaming: true,
                  });
                } else {
                  const id = currentTextId;
                  const idx = blocks.findIndex(
                    (b) => b.type === 'text' && b.id === id,
                  );
                  if (idx >= 0) {
                    const orig = blocks[idx] as TextBlock;
                    // Replace the block immutably — BlockRenderer is wrapped
                    // in React.memo, so without a fresh reference the partial
                    // tokens we just appended would not re-render and the
                    // user would see a stuck/incomplete message.
                    blocks[idx] = { ...orig, text: orig.text + event.text };
                  }
                }
                flush();
                break;
              }
              case 'text_stop': {
                if (currentTextId) {
                  const id = currentTextId;
                  const idx = blocks.findIndex(
                    (b) => b.type === 'text' && b.id === id,
                  );
                  if (idx >= 0) {
                    const orig = blocks[idx] as TextBlock;
                    blocks[idx] = { ...orig, streaming: false };
                  }
                  currentTextId = null;
                  flush();
                }
                break;
              }
              case 'thinking_start': {
                ensureAssistantForActiveTurn();
                currentThinkingId = newId('blk');
                blocks.push({
                  type: 'thinking',
                  id: currentThinkingId,
                  text: '',
                  streaming: true,
                });
                flush();
                break;
              }
              case 'thinking_delta': {
                ensureAssistantForActiveTurn();
                if (!currentThinkingId) {
                  currentThinkingId = newId('blk');
                  blocks.push({
                    type: 'thinking',
                    id: currentThinkingId,
                    text: event.text,
                    streaming: true,
                  });
                } else {
                  const id = currentThinkingId;
                  const idx = blocks.findIndex(
                    (b) => b.type === 'thinking' && b.id === id,
                  );
                  if (idx >= 0) {
                    const orig = blocks[idx] as ThinkingBlock;
                    blocks[idx] = { ...orig, text: orig.text + event.text };
                  }
                }
                flush();
                break;
              }
              case 'thinking_stop': {
                if (currentThinkingId) {
                  const id = currentThinkingId;
                  const idx = blocks.findIndex(
                    (b) => b.type === 'thinking' && b.id === id,
                  );
                  if (idx >= 0) {
                    const orig = blocks[idx] as ThinkingBlock;
                    blocks[idx] = { ...orig, streaming: false };
                  }
                  currentThinkingId = null;
                  flush();
                }
                break;
              }
              case 'tool_use_start': {
                ensureAssistantForActiveTurn();
                closeStreamingInline();
                const exists = blocks.some(
                  (b) => b.type === 'tool_use' && b.toolUseId === event.toolUseId,
                );
                if (!exists) {
                  blocks.push({
                    type: 'tool_use',
                    id: newId('blk'),
                    toolUseId: event.toolUseId,
                    name: event.name,
                    input: {},
                    streaming: true,
                  });
                  flush();
                }
                break;
              }
              case 'tool_use_input': {
                const idx = blocks.findIndex(
                  (b) => b.type === 'tool_use' && b.toolUseId === event.toolUseId,
                );
                if (idx >= 0) {
                  const orig = blocks[idx] as ToolUseBlock;
                  blocks[idx] = {
                    ...orig,
                    name: event.name,
                    input: event.input,
                    streaming: false,
                  };
                  flush();
                } else {
                  // Tool was cut into a split segment mid-stream — patch the
                  // finalized message it now lives in.
                  patchToolBlockInSplitSegments(event.toolUseId, (orig) => ({
                    ...orig,
                    name: event.name,
                    input: event.input,
                    streaming: false,
                  }));
                }
                break;
              }
              case 'tool_use': {
                ensureAssistantForActiveTurn();
                closeStreamingInline();
                blocks.push({
                  type: 'tool_use',
                  id: newId('blk'),
                  toolUseId: event.toolUseId,
                  name: event.name,
                  input: event.input,
                });
                flush();
                break;
              }
              case 'tool_result': {
                const idx = blocks.findIndex(
                  (b) => b.type === 'tool_use' && b.toolUseId === event.toolUseId,
                );
                if (idx >= 0) {
                  const orig = blocks[idx] as ToolUseBlock;
                  blocks[idx] = {
                    ...orig,
                    result: { content: event.content, isError: event.isError },
                  };
                  flush();
                } else {
                  // Tool ran across a mid-loop split — its card lives in an
                  // already-finalized message. Attach the result there so it
                  // never shows as forever-running.
                  patchToolBlockInSplitSegments(event.toolUseId, (orig) => ({
                    ...orig,
                    result: { content: event.content, isError: event.isError },
                  }));
                }
                if (
                  stateRef.current.instances.find((i) => i.id === instId)
                    ?.pendingQuestion?.toolUseId === event.toolUseId
                ) {
                  patch(instId, { pendingQuestion: null });
                }
                break;
              }
              case 'awaiting_question': {
                const questions = parseAskUserQuestionInput(event.input);
                if (questions.length > 0) {
                  patch(instId, {
                    pendingQuestion: { toolUseId: event.toolUseId, questions },
                  });
                }
                break;
              }
              case 'question_answered': {
                const idx = blocks.findIndex(
                  (b) => b.type === 'tool_use' && b.toolUseId === event.toolUseId,
                );
                if (idx >= 0) {
                  const orig = blocks[idx] as ToolUseBlock;
                  blocks[idx] = { ...orig, answers: event.answers };
                  flush();
                } else {
                  patchToolBlockInSplitSegments(event.toolUseId, (orig) => ({
                    ...orig,
                    answers: event.answers,
                  }));
                }
                if (
                  stateRef.current.instances.find((i) => i.id === instId)
                    ?.pendingQuestion?.toolUseId === event.toolUseId
                ) {
                  patch(instId, { pendingQuestion: null });
                }
                break;
              }
              case 'refusal': {
                // Safety-classifier decline — render the dedicated refusal
                // block, not an error block. Close any half-open inline
                // blocks first so the refusal doesn't append mid-paragraph.
                ensureAssistantForActiveTurn();
                closeStreamingInline();
                blocks.push({
                  type: 'refusal',
                  id: newId('blk'),
                  model: event.model,
                  category: event.category,
                  explanation: event.explanation,
                });
                flush();
                break;
              }
              case 'rate_limit': {
                // Account-global gauge — goes to the shared usage store, not
                // per-instance state.
                setRateLimitUsage({
                  status: event.status,
                  utilization: event.utilization,
                  rateLimitType: event.rateLimitType,
                  resetsAt: event.resetsAt,
                  isUsingOverage: event.isUsingOverage,
                  receivedAt: Date.now(),
                });
                break;
              }
              case 'usage': {
                // Account-global gauge — goes to the shared usage store, not
                // per-instance state.
                setPlanUsage({
                  fiveHour: event.fiveHour,
                  sevenDay: event.sevenDay,
                  sevenDayOpus: event.sevenDayOpus,
                  sevenDaySonnet: event.sevenDaySonnet,
                  extraUsage: event.extraUsage,
                  receivedAt: Date.now(),
                });
                break;
              }
              case 'token_budget': {
                patch(instId, { tokensUsed: event.used });
                break;
              }
              case 'compact_boundary': {
                const compactBlock: CompactBoundaryBlock = {
                  type: 'compact_boundary',
                  id: newId('blk'),
                  trigger: event.trigger,
                  preTokens: event.preTokens,
                  postTokens: event.postTokens,
                  durationMs: event.durationMs,
                };
                const sysMsg: SystemMessage = {
                  id: event.messageId,
                  role: 'system',
                  blocks: [compactBlock],
                  createdAt: Date.now(),
                };
                appendMessage(instId, sysMsg);
                if (event.postTokens != null) {
                  patch(instId, { tokensUsed: event.postTokens });
                }
                break;
              }
              case 'message_complete': {
                // Server signaled this assistant turn is fully done. Finalize
                // so the streaming cursor disappears even if more turns
                // follow in the same stream.
                finalizeActiveTurn();
                blocks = [];
                currentTextId = null;
                currentThinkingId = null;
                break;
              }
              case 'error': {
                if (!compact) {
                  ensureAssistantForActiveTurn();
                  blocks.push({
                    type: 'error',
                    id: newId('blk'),
                    text: `Error: ${event.error}`,
                  });
                  flush();
                }
                break;
              }
              case 'complete': {
                break;
              }
            }
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError') {
          if (!compact) {
            // If we never made it to a turn, the optimistic assistant for
            // turn 0 still exists and needs an error block; otherwise attach
            // to the currently-active turn.
            if (!activeAssistantId) {
              activeAssistantId = assistantId;
            }
            ensureAssistantForActiveTurn();
            blocks.push({
              type: 'error',
              id: newId('blk'),
              text: `Error: ${err instanceof Error ? err.message : 'Network error'}`,
            });
            flush();
          }
        }
      } finally {
        finalizeActiveTurn();
        patch(instId, {
          streaming: false,
          streamingMessageId: null,
          compacting: false,
        });
        aborterRef.current = null;
        if (liveStreamRef.current?.instanceId === instId) {
          liveStreamRef.current = null;
        }
        turnSplitRef.current = null;
        streamInFlightRef.current = false;

        // Fallback drain: any queued messages that never got injected (e.g.
        // because the stream closed before we managed to POST them) get sent
        // one at a time as fresh /api/chat requests. This is also the
        // recovery path for `injectMessage` returning 410.
        if (!compact) {
          const after = stateRef.current.instances.find((i) => i.id === instId);
          const next = after?.queuedMessages[0];
          if (next) {
            removeQueuedMessage(instId, next.id);
            queueMicrotask(() => {
              void runStreamRef.current?.({
                prompt: next.text,
                images: next.images?.map((img) => ({
                  dataUrl: img.dataUrl,
                  mediaType: img.mediaType,
                  name: img.name,
                })),
                userMessageId: next.userMessageId,
                assistantMessageId: next.assistantMessageId,
              });
            });
          }
        }
      }
    },
    [
      stateRef,
      patch,
      appendMessage,
      appendUserMessageIfAbsent,
      updateMessage,
      removeQueuedMessage,
      enqueueMessage,
      injectMessage,
    ],
  );

  /**
   * Self-reference so the fallback-drain step at the bottom of `runStream`
   * can recurse without depending on its own declaration order. Kept in
   * sync via useEffect so we never assign during render (React rule).
   */
  const runStreamRef = useRef<
    ((opts: SendOptions) => Promise<void>) | null
  >(null);
  useEffect(() => {
    runStreamRef.current = runStream;
  }, [runStream]);

  const send = useCallback(
    (text: string, images?: SendImage[], effort?: EffortLevel) =>
      runStream({ prompt: text, images, effort }),
    [runStream],
  );

  /**
   * Queue a message for the active instance. If a stream is live, we
   * immediately try to inject the message into it — that's the mid-loop
   * delivery path that lets the model see new input between tool calls. If
   * the stream is no longer accepting input (e.g. just closed), we leave
   * the message in the queue for the fallback drain to send as a fresh
   * `/api/chat` POST.
   */
  const queue = useCallback(
    (text: string, images?: SendImage[]): QueuedMessage | null => {
      const trimmed = text.trim();
      if (!trimmed && (!images || images.length === 0)) return null;
      const inst = stateRef.current.instances.find(
        (i) => i.id === stateRef.current.activeId,
      );
      if (!inst) return null;
      const userMessageId = newId('user');
      const assistantMessageId = newId('asst');
      const msg: QueuedMessage = {
        id: newId('q'),
        userMessageId,
        assistantMessageId,
        text: trimmed,
        images: images?.map((img) => ({
          id: newId('img'),
          dataUrl: img.dataUrl,
          mediaType: img.mediaType,
          name: img.name,
        })),
        createdAt: Date.now(),
      };
      // Mid-loop visibility: land the user bubble in the conversation canvas
      // immediately, the same way `send()` does for the first turn. The
      // server's eventual `turn_started` event will hit the `alreadyInChat`
      // branch and skip re-appending. Without this the message would sit
      // invisible in the backend queue until the current function-call loop
      // finished, which is exactly the bug we're fixing.
      appendUserMessageIfAbsent(inst.id, userMessageId, trimmed, images);
      // Keep the canvas chronological: close the streaming assistant message
      // so blocks generated after this send render BELOW the user bubble
      // instead of growing the message above it.
      turnSplitRef.current?.(inst.id);
      enqueueMessage(inst.id, msg);
      // Fire-and-forget — the inject result drives nothing visible directly;
      // a successful inject results in a server `turn_started` event which
      // will move the message from the queue UI into the chat. A failed
      // inject (no live stream) leaves it queued, and either the user's
      // next send opens a new stream that picks it up, or the current
      // stream's finally-block drain does.
      void injectMessage(msg, images);
      return msg;
    },
    [stateRef, appendUserMessageIfAbsent, enqueueMessage, injectMessage],
  );

  const unqueue = useCallback(
    (msgId: string) => {
      const inst = stateRef.current.instances.find(
        (i) => i.id === stateRef.current.activeId,
      );
      if (!inst) return;
      removeQueuedMessage(inst.id, msgId);
    },
    [stateRef, removeQueuedMessage],
  );

  const compact = useCallback(
    () => runStream({ prompt: '/compact', compact: true }),
    [runStream],
  );

  const abort = useCallback(() => {
    aborterRef.current?.abort();
  }, []);

  const submitAnswer = useCallback(
    async (toolUseId: string, answers: Record<string, string>) => {
      const inst = stateRef.current.instances.find(
        (i) => i.id === stateRef.current.activeId,
      );
      if (inst?.pendingQuestion?.toolUseId === toolUseId) {
        patch(inst.id, { pendingQuestion: null });
      }
      try {
        await fetch('/api/chat/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, answers }),
        });
      } catch {
        /* swallow — server will time out the question if needed */
      }
    },
    [stateRef, patch],
  );

  return { send, queue, unqueue, compact, abort, submitAnswer };
}
