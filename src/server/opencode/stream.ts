/**
 * Drives one `/api/chat` stream on the OpenCode backend.
 *
 * `/api/chat` computes everything backend-agnostic first — the resolved model,
 * the workspace, the assembled system prompt — then hands off to either the
 * Agent SDK loop or this function. Both emit the same `StreamEvent`s and write
 * through the same storage helpers, so a conversation is stored identically no
 * matter which harness produced it and the two can be mixed freely within one
 * workspace.
 *
 * What differs is the turn loop, which is why this is a separate function
 * rather than a branch inside the other one. The Agent SDK is fed by an
 * AsyncIterable it pulls from, so turns roll forward implicitly as the SDK asks
 * for more input; OpenCode takes one prompt per HTTP call and returns when the
 * turn is done, so turns are an explicit loop here. Trying to express both in
 * one code path would obscure both.
 *
 * The conversation id is OpenCode's own session id. That keeps resume working
 * without a translation table, and it is why none of the Claude-CLI transcript
 * machinery (`transcriptRepair`, `sdkTranscriptPath`) is reachable from this
 * path — OpenCode owns its own session storage and exposes it over the API.
 */

import {
  ensureConversation,
  nextMessageSeq,
  setConversationTitle,
  touchConversation,
  upsertMessage,
} from '@/server/conversations';
import { readNotebook, writeNotebook } from '@/server/notebook';
import { createNotebookMcpServer } from '@/server/notebookTools';
import { createRemoteMcpServer } from '@/server/sshTools';
import { createLocalMcpServer } from '@/server/localTools';
import {
  createMcpManagerServer,
  proxyMcpServerFactory,
} from '@/server/mcpConnector';
import { listServersForWorkspace } from '@/server/mcpRegistry';
import {
  createVisionMcpServer,
  providerInjectsVision,
} from '@/server/visionTools';
import {
  registerActiveStream,
  type InjectRequest,
  type InjectResult,
} from '@/server/activeChatStreams';
import type { StreamEvent } from '@/lib/streamEvents';
import type { ContentBlock, ImageAttachmentBlock } from '@/lib/types';
import type { ModelId } from '@/lib/models';
import type { McpServerFactory } from './mcpBridge';
import { startOpencodeBackend } from './server';
import { startOpencodeRunner } from './run';

/**
 * Tools OpenCode must not use in an SSH workspace.
 *
 * Its built-ins operate on the machine it runs on — this server — while the
 * user is looking at a remote filesystem. The `remote` MCP server provides the
 * same capabilities over SSH, so the local originals are switched off to stop
 * the model reaching for the wrong one. Mirrors `disallowedTools` on the Agent
 * SDK path, using OpenCode's own tool ids.
 */
const REMOTE_BLOCKED_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'apply_patch',
];

export type OpencodeStreamOptions = {
  model: ModelId;
  /** Workspace as the user sees it — a local path or an `ssh://` URL. */
  cwd: string;
  /** Real local directory OpenCode runs in. */
  directory: string;
  isRemote: boolean;
  /** Existing OpenCode session to resume, or null to start one. */
  sessionId: string | null;
  /** Fully-assembled system prompt (core prefix + environment + notebook). */
  system: string;
  prompt: string;
  userMessageId: string;
  assistantMessageId: string;
  images?: { dataUrl: string; mediaType: string; name?: string }[];
  userImages?: ImageAttachmentBlock[];
  ephemeral: boolean;
  /** Stable id the client uses with `/api/chat/inject`. */
  streamId: string;
  send: (event: StreamEvent) => void;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
};

type QueuedTurn = {
  prompt: string;
  userMessageId: string;
  assistantMessageId: string;
  images?: { dataUrl: string; mediaType: string; name?: string }[];
  userImages?: ImageAttachmentBlock[];
};

/**
 * How long to hold the stream open after a turn ends, waiting for an
 * `/api/chat/inject` the user fired just as the model went idle. Matches the
 * Agent SDK path's grace so both backends feel the same to type against.
 */
const POST_TURN_GRACE_MS = 150;

export async function runOpencodeStream(
  opts: OpencodeStreamOptions,
): Promise<void> {
  const { send } = opts;

  // Conversation id is only known once OpenCode mints the session, but the
  // notebook tool must work on the very first turn — so notes written before
  // then are buffered and flushed the moment the id exists. Same contract the
  // Agent SDK path provides.
  let conversationId: string | null = null;
  let pendingNotebook: string | null = null;

  const mcpFactories: Record<string, McpServerFactory> = {
    notebook: () =>
      createNotebookMcpServer({
        read: () =>
          conversationId ? readNotebook(conversationId) : (pendingNotebook ?? ''),
        write: (content) => {
          if (conversationId) {
            writeNotebook(conversationId, content, Date.now());
            pendingNotebook = null;
          } else {
            pendingNotebook = content;
          }
        },
      }).instance,
  };

  if (opts.isRemote) {
    // Built per MCP session, not once: an `McpServer` binds to a single
    // transport, so a reused instance would fail to connect if OpenCode ever
    // reconnects. The underlying SSH connection is memoised by host, so extra
    // instances share one connection rather than opening new ones.
    mcpFactories.remote = async () =>
      (await createRemoteMcpServer({ workspaceCwd: opts.cwd })).instance;
    // The counterpart to `remote`: REMOTE_BLOCKED_TOOLS takes away every
    // built-in that touches this machine, so without this a remote session has
    // no way back to the host cloudchat is running on. Same per-session
    // construction rule as above — one McpServer, one transport.
    mcpFactories.local = () => createLocalMcpServer().instance;
  }
  if (providerInjectsVision(opts.model)) {
    mcpFactories.vision = () =>
      createVisionMcpServer({ model: opts.model, workspaceCwd: opts.cwd })
        .instance;
  }

  // Third-party MCP servers configured for THIS FOLDER, plus the `mcp`
  // management tools. Same shapes the Agent SDK path uses — the bridge
  // republishes them. Registry changes land on the next turn, when these
  // factories are rebuilt.
  for (const entry of listServersForWorkspace(opts.cwd)) {
    mcpFactories[entry.name] = () => proxyMcpServerFactory(entry)().instance;
  }
  mcpFactories.mcp = () =>
    createMcpManagerServer({ workspaceCwd: opts.cwd, isRemote: opts.isRemote })
      .instance;

  const backend = await startOpencodeBackend({
    model: opts.model,
    cwd: opts.directory,
    mcpFactories,
    env: opts.env,
    signal: opts.signal,
  });

  // ===== Turn queue =====
  const queue: QueuedTurn[] = [];
  let acceptingInjects = true;
  let wakeQueue: (() => void) | null = null;

  const unregister = registerActiveStream(opts.streamId, {
    push: (req: InjectRequest): InjectResult => {
      if (!acceptingInjects) return { ok: false, reason: 'stream-closing' };
      queue.push({
        prompt: req.prompt,
        userMessageId: req.userMessageId,
        assistantMessageId: req.assistantMessageId,
        images: req.images,
        userImages: req.userImages,
      });
      wakeQueue?.();
      return { ok: true };
    },
  });

  try {
    // Resume when the client supplied a session; otherwise start one. A resume
    // whose session OpenCode no longer knows falls back to a fresh session
    // rather than failing the turn.
    let sessionId = opts.sessionId;
    if (sessionId) {
      try {
        const existing = await backend.client.session.get({
          path: { id: sessionId },
        });
        if (existing.error || !existing.data) sessionId = null;
      } catch {
        // A missing session comes back as a 404 in `existing.error`, but a
        // transport-level failure REJECTS instead. Either way the session is
        // not usable, and starting a fresh one beats failing the turn.
        sessionId = null;
      }
    }
    if (!sessionId) {
      const created = await backend.client.session.create({
        body: { title: makeTitle(opts.prompt) },
      });
      if (created.error || !created.data) {
        throw new Error('OpenCode could not create a session');
      }
      sessionId = created.data.id;
    }

    conversationId = sessionId;
    const now = Date.now();
    ensureConversation(sessionId, opts.cwd, now, {
      ephemeral: opts.ephemeral,
      backend: 'opencode',
    });
    if (pendingNotebook != null) {
      writeNotebook(sessionId, pendingNotebook, now);
      pendingNotebook = null;
    }
    if (!opts.sessionId) setConversationTitle(sessionId, makeTitle(opts.prompt));
    send({ type: 'session', sessionId });

    const runner = await startOpencodeRunner({
      client: backend.client,
      sessionId,
      directory: opts.directory,
      model: opts.model,
      system: opts.system,
      mcpServerNames: Object.keys(mcpFactories),
      disabledTools: opts.isRemote ? REMOTE_BLOCKED_TOOLS : undefined,
      diffCwd: opts.isRemote ? opts.directory : opts.cwd,
      env: opts.env,
      send,
    });

    // Stop OpenCode as soon as the client disconnects, rather than letting the
    // model keep spending tokens on a turn nobody is reading.
    const onAbort = () => void runner.abort();
    opts.signal.addEventListener('abort', onAbort, { once: true });

    try {
      let turn: QueuedTurn | undefined = {
        prompt: opts.prompt,
        userMessageId: opts.userMessageId,
        assistantMessageId: opts.assistantMessageId,
        images: opts.images,
        userImages: opts.userImages,
      };
      let turnIndex = 0;

      while (turn && !opts.signal.aborted) {
        send({
          type: 'turn_started',
          turnIndex,
          userMessageId: turn.userMessageId,
          assistantMessageId: turn.assistantMessageId,
          prompt: turn.prompt,
          images: turn.userImages,
        });

        const userSeq = persistUser(sessionId, turn);
        const result = await runner.runTurn({
          prompt: turn.prompt,
          images: turn.images,
        });

        persistAssistant(sessionId, turn.assistantMessageId, userSeq + 1, [
          ...result.blocks,
          ...(result.error
            ? ([
                {
                  type: 'error',
                  id: `blk_err_${turnIndex}`,
                  text: `Error: ${result.error}`,
                },
              ] as ContentBlock[])
            : []),
        ]);
        if (result.error) send({ type: 'error', error: result.error });
        send({
          type: 'message_complete',
          assistantMessageId: turn.assistantMessageId,
        });

        turn = await nextTurn();
        turnIndex += 1;
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      runner.dispose();
    }

    send({ type: 'complete' });
  } finally {
    acceptingInjects = false;
    unregister();
    backend.dispose();
  }

  /** Take the next queued turn, waiting briefly for a racing inject. */
  async function nextTurn(): Promise<QueuedTurn | undefined> {
    if (queue.length > 0) return queue.shift();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeQueue = null;
        resolve();
      }, POST_TURN_GRACE_MS);
      wakeQueue = () => {
        clearTimeout(timer);
        wakeQueue = null;
        resolve();
      };
    });
    return queue.shift();
  }

  function persistUser(id: string, turn: QueuedTurn): number {
    const userBlocks: ContentBlock[] = [];
    if (turn.userImages?.length) userBlocks.push(...turn.userImages);
    if (turn.prompt) {
      userBlocks.push({
        type: 'text',
        id: `blk_u_${turn.userMessageId}`,
        text: turn.prompt,
      });
    }
    const seq = nextMessageSeq(id);
    persistSafely(() => {
      upsertMessage({
        id: turn.userMessageId,
        conversationId: id,
        role: 'user',
        seq,
        createdAt: Date.now(),
        blocks: userBlocks,
      });
    });
    return seq;
  }

  function persistAssistant(
    id: string,
    messageId: string,
    seq: number,
    blocks: ContentBlock[],
  ) {
    persistSafely(() => {
      upsertMessage({
        id: messageId,
        conversationId: id,
        role: 'assistant',
        seq,
        createdAt: Date.now(),
        blocks,
      });
      touchConversation(id, Date.now());
    });
  }
}

/**
 * Persistence must never take a turn down: the user can still read the answer
 * on screen even if storing it failed, and killing the stream would lose it
 * entirely.
 */
function persistSafely(fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error('[opencode] persist failed:', err);
  }
}

function makeTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 79)}…`;
}
