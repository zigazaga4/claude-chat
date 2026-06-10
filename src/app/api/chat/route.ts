import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { NextRequest } from 'next/server';
import { readSystemPrompt } from '@/server/systemPrompt';
import {
  ensureConversation,
  nextMessageSeq,
  setConversationTitle,
  touchConversation,
  upsertMessage,
} from '@/server/conversations';
import { awaitAnswers, type Answers } from '@/server/pendingQuestions';
import {
  registerActiveStream,
  type InjectRequest,
  type InjectResult,
} from '@/server/activeChatStreams';
import { parseCwd } from '@/lib/cwd';
import { createRemoteMcpServer } from '@/server/sshTools';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';
import {
  DEFAULT_MODEL_ID,
  getDefaultEffort,
  getModelInfo,
  isValidEffort,
  isValidModelId,
  type EffortLevel,
  type ModelId,
} from '@/lib/models';
import type {
  CompactBoundaryBlock,
  ContentBlock,
  ImageAttachmentBlock,
  ImageMediaType,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FALLBACK_MODEL: ModelId =
  (process.env.CLAUDECHAT_MODEL && isValidModelId(process.env.CLAUDECHAT_MODEL)
    ? (process.env.CLAUDECHAT_MODEL as ModelId)
    : DEFAULT_MODEL_ID);

/**
 * Always-on thinking config for the SDK. Adaptive thinking ("Claude decides
 * when and how much to think", Opus 4.6+) stays on for the models that have
 * it; Haiku — which has no adaptive mode — runs extended thinking. Either way
 * thinking is never disabled here. The `effort` knob (resolved separately)
 * is what actually controls thinking depth.
 */
type SdkThinking =
  | { type: 'adaptive'; display: 'summarized' | 'omitted' }
  | { type: 'enabled'; display: 'summarized' | 'omitted'; budgetTokens?: number };

function thinkingForModel(model: ModelId): SdkThinking {
  // 'summarized' display matches what the route hard-coded before this change.
  return getModelInfo(model).thinkingType === 'adaptive'
    ? { type: 'adaptive', display: 'summarized' }
    : { type: 'enabled', display: 'summarized' };
}

/**
 * Resolve the client's requested model + effort against the registry. Every
 * model supports the full effort ladder, so the only coercion needed is: bad
 * model → fallback model; bad/absent effort → that model's default effort.
 * Never trust the wire payload to be in sync with the server registry.
 */
function resolveModelSelection(
  rawModel: unknown,
  rawEffort: unknown,
): { model: ModelId; effort: EffortLevel; sdkThinking: SdkThinking } {
  const model: ModelId =
    typeof rawModel === 'string' && isValidModelId(rawModel)
      ? rawModel
      : FALLBACK_MODEL;
  const effort: EffortLevel =
    typeof rawEffort === 'string' && isValidEffort(rawEffort)
      ? rawEffort
      : getDefaultEffort(model);
  return { model, effort, sdkThinking: thinkingForModel(model) };
}

/**
 * After the model finishes a turn we wait briefly for any in-flight
 * `/api/chat/inject` POST that the user fired just before we saw `result`. If
 * the queue is still empty after this window, we close the SDK input and let
 * the stream exit. Tuning trade-off: a longer grace catches more race-y
 * injects at the cost of holding the HTTP response open after the model has
 * gone idle.
 */
const POST_TURN_GRACE_MS = 150;

type RequestImage = {
  dataUrl: string;
  mediaType: ImageMediaType;
  name?: string;
};

type ChatRequest = {
  prompt: string;
  cwd: string;
  mode?: 'default' | 'auto' | 'acceptEdits' | 'bypassPermissions';
  sessionId?: string | null;
  userMessageId: string;
  assistantMessageId: string;
  images?: RequestImage[];
  compact?: boolean;
  /** Client-selected model — validated against the registry; falls back if absent/invalid. */
  model?: string;
  /** Client-selected effort ("thinking power") — falls back to the model default. */
  effort?: string;
};

type StreamEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'stream_ready';
      /** Echo of the first assistantMessageId — clients use it as the inject key. */
      streamId: string;
    }
  | {
      type: 'turn_started';
      /** Index of this turn within the stream — first turn is 0. */
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
      /** Safety-classifier decline — HTTP 200 with stop_reason "refusal", not an error. */
      type: 'refusal';
      model: string;
      category?: string | null;
      explanation?: string | null;
    }
  | {
      /** Account-level subscription usage from the SDK's rate_limit_event. */
      type: 'rate_limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      utilization?: number;
      rateLimitType?: string;
      resetsAt?: number;
      isUsingOverage?: boolean;
    }
  | {
      /**
       * Structured /usage data (the SDK control request behind Claude Code's
       * /usage command): per-window utilization percentages, fetched after
       * every function-calling loop. resetsAt values are epoch ms.
       */
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

const NDJSON_ENCODER = new TextEncoder();
function encodeNDJSON(event: StreamEvent) {
  return NDJSON_ENCODER.encode(`${JSON.stringify(event)}\n`);
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  return v && typeof v === 'object' ? (v as AnyRecord) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const r = asRecord(part);
        if (!r) return '';
        if (r.type === 'text' && typeof r.text === 'string') return r.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function newBlockId() {
  return `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_PRIOR_BYTES = 256 * 1024;

function readPriorFileContent(cwd: string, filePath: string): string | null {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_PRIOR_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function augmentToolInput(
  name: string,
  input: unknown,
  cwd: string,
): unknown {
  if (name !== 'Write' && name !== 'Edit') return input;
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : '';
  if (!filePath) return input;
  const prior = readPriorFileContent(cwd, filePath);
  return { ...obj, _priorContent: prior };
}

function gitFromCwd(cwd: string): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .toString()
      .trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).toString();
    const dirty = status.split('\n').filter(Boolean).length;
    return dirty > 0
      ? `branch \`${branch}\` (${dirty} modified file${dirty === 1 ? '' : 's'})`
      : `branch \`${branch}\` (clean)`;
  } catch {
    return 'not a git repository';
  }
}

function readOsRelease(): string | null {
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    const m = raw.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function nowStrings() {
  const now = new Date();
  return {
    isoUtc: now.toISOString(),
    epochMs: now.getTime(),
    localStr: now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function buildLocalEnvBlock(cwd: string): string {
  const { isoUtc, epochMs, localStr, tz } = nowStrings();
  const distro = readOsRelease();
  const memTotalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  const memFreeGb = (os.freemem() / 1024 ** 3).toFixed(1);
  return `# Working environment

- Working directory: ${cwd}
- Today's date (local): ${localStr}
- Timestamp (UTC ISO): ${isoUtc}
- Unix epoch (ms): ${epochMs}
- Time zone: ${tz}
- Platform: ${process.platform} (${process.arch})
- OS: ${distro ?? os.type()} — kernel ${os.release()}
- Hostname: ${os.hostname()}
- User: ${os.userInfo().username} (home ${os.homedir()})
- CPUs: ${os.cpus().length} × ${os.cpus()[0]?.model ?? 'unknown'}
- Memory: ${memFreeGb} GB free of ${memTotalGb} GB
- Node: ${process.version}
- Git: ${gitFromCwd(cwd)}`;
}

async function buildSshEnvBlock(cwd: string): Promise<string> {
  const { isoUtc, epochMs, localStr, tz } = nowStrings();
  const parsed = parseCwd(cwd);
  if (parsed.kind !== 'ssh') return buildLocalEnvBlock(cwd);

  const ws = getWorkspace(cwd);
  const stored = getStoredSshPassword(cwd);
  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws?.sshIdentityPath ?? null,
    useAgent: ws?.sshUseAgent ?? false,
    expectedHostFingerprint: ws?.sshKnownHostFp ?? null,
    password: stored ?? undefined,
  };

  let remoteUname = '(remote uname unavailable)';
  let remoteDistro = '(unknown)';
  let remoteHostname = parsed.host;
  let remoteUser = parsed.user;
  let remoteHome = '~';
  let remoteGit = '(no git status — connection failed)';
  try {
    const host = await getHost(opts);
    const cd = `cd ${shellQuote(parsed.path)} 2>/dev/null;`;
    const [unameR, distroR, hostR, userR, homeR, gitBranchR, gitStatusR] = await Promise.all([
      host.exec('uname -a').catch(() => ({ stdout: '' })),
      host
        .exec(
          `sh -c "(. /etc/os-release 2>/dev/null && printf %s \\"$PRETTY_NAME\\") || uname -sr"`,
        )
        .catch(() => ({ stdout: '' })),
      host.exec('hostname').catch(() => ({ stdout: '' })),
      host.exec('whoami').catch(() => ({ stdout: '' })),
      host.exec('printf %s "$HOME"').catch(() => ({ stdout: '' })),
      host
        .exec(`${cd} git rev-parse --abbrev-ref HEAD 2>/dev/null`)
        .catch(() => ({ stdout: '' })),
      host
        .exec(`${cd} git status --porcelain 2>/dev/null | wc -l`)
        .catch(() => ({ stdout: '' })),
    ]);
    remoteUname = unameR.stdout.trim() || remoteUname;
    remoteDistro = distroR.stdout.trim() || remoteDistro;
    remoteHostname = hostR.stdout.trim() || remoteHostname;
    remoteUser = userR.stdout.trim() || remoteUser;
    remoteHome = homeR.stdout.trim() || remoteHome;
    const branch = gitBranchR.stdout.trim();
    if (branch) {
      const dirty = parseInt(gitStatusR.stdout.trim() || '0', 10) || 0;
      remoteGit =
        dirty > 0
          ? `branch \`${branch}\` (${dirty} modified file${dirty === 1 ? '' : 's'})`
          : `branch \`${branch}\` (clean)`;
    } else {
      remoteGit = 'not a git repository';
    }
  } catch (err) {
    remoteGit = `(probe failed: ${err instanceof Error ? err.message : 'unknown'})`;
  }

  return `# Working environment (REMOTE via SSH)

You are operating on a remote host over SSH. The local machine running this UI
is a thin client. **Do not** use the built-in Bash, Read, Write, Edit, Glob,
Grep, LS, NotebookEdit, BashOutput, or KillShell tools — they would target the
local machine and would be useless here. Instead use the equivalent
\`mcp__remote__bash\`, \`mcp__remote__read\`, \`mcp__remote__write\`,
\`mcp__remote__edit\`, \`mcp__remote__glob\`, \`mcp__remote__grep\`, and
\`mcp__remote__ls\` tools — they execute on the remote host below.

- Remote workspace cwd: ${parsed.path}
- Remote URI: ${cwd}
- Remote host: ${remoteHostname} (${parsed.host}:${parsed.port})
- Remote user: ${remoteUser} (home ${remoteHome})
- Remote OS: ${remoteDistro}
- Remote kernel: ${remoteUname}
- Remote git: ${remoteGit}
- Today's date (client local): ${localStr}
- Timestamp (UTC ISO): ${isoUtc}
- Unix epoch (ms): ${epochMs}
- Client time zone: ${tz}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function newSystemMessageId() {
  return `sys_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 79)}…`;
}

const ALLOWED_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

type ImageContentBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
};

type TextContentBlock = { type: 'text'; text: string };

function buildImageContentBlocks(images: RequestImage[] | undefined): ImageContentBlock[] {
  if (!images || images.length === 0) return [];
  const out: ImageContentBlock[] = [];
  for (const img of images) {
    if (!ALLOWED_MEDIA_TYPES.has(img.mediaType)) continue;
    const parsed = parseDataUrl(img.dataUrl);
    if (!parsed) continue;
    out.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: parsed.data,
      },
    });
  }
  return out;
}

function buildUserImageBlocks(
  images: RequestImage[] | undefined,
): ImageAttachmentBlock[] | undefined {
  if (!images || images.length === 0) return undefined;
  const out: ImageAttachmentBlock[] = [];
  for (const img of images) {
    if (!ALLOWED_MEDIA_TYPES.has(img.mediaType)) continue;
    if (!parseDataUrl(img.dataUrl)) continue;
    out.push({
      type: 'image',
      id: newBlockId(),
      dataUrl: img.dataUrl,
      mediaType: img.mediaType,
      name: img.name,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build the SDK-shaped user message payload — a plain string when there's no
 * attached image, otherwise a content-block array with text + base64 images.
 */
function buildSdkUserMessageContent(
  text: string,
  imageBlocks: ImageContentBlock[],
): string | Array<TextContentBlock | ImageContentBlock> {
  if (imageBlocks.length === 0) return text;
  const content: Array<TextContentBlock | ImageContentBlock> = [];
  if (text) content.push({ type: 'text', text });
  for (const img of imageBlocks) content.push(img);
  return content;
}

type SdkUserMessage = {
  type: 'user';
  message: { role: 'user'; content: string | Array<TextContentBlock | ImageContentBlock> };
  parent_tool_use_id: null;
  session_id: string;
};

/** Metadata for one turn — paired up with its SDK payload in the input queue. */
type TurnMeta = {
  turnIndex: number;
  userMessageId: string;
  assistantMessageId: string;
  prompt: string;
  userImages?: ImageAttachmentBlock[];
};

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    prompt,
    cwd,
    mode,
    sessionId,
    userMessageId,
    assistantMessageId,
    images,
    compact,
    model: requestedModel,
    effort: requestedEffort,
  } = body;
  if (!prompt || !cwd || !userMessageId || !assistantMessageId) {
    return Response.json(
      { error: 'prompt, cwd, userMessageId, and assistantMessageId are required' },
      { status: 400 },
    );
  }

  const { model: resolvedModel, sdkThinking, effort } = resolveModelSelection(
    requestedModel,
    requestedEffort,
  );

  const isCompactOp = !!compact;
  /**
   * Stable identifier the client uses with /api/chat/inject. We use the
   * caller-allocated assistantMessageId of the first turn — it's already in
   * the client's hand at submit time. Compact ops are uninjectable so they
   * don't register themselves.
   */
  const streamId = assistantMessageId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let controllerClosed = false;
      const send = (e: StreamEvent) => {
        if (controllerClosed) return;
        try {
          controller.enqueue(encodeNDJSON(e));
        } catch {
          controllerClosed = true;
        }
      };

      // ===== Per-turn state =====
      // `currentTurn` is the turn whose events we're currently piping out.
      // It rolls forward in `beginNextTurn` — never inside the generator —
      // so that previous-turn events that may still arrive don't accidentally
      // get attributed to the new turn.
      let currentTurn: TurnMeta = {
        turnIndex: -1,
        userMessageId: '',
        assistantMessageId: '',
        prompt: '',
        userImages: undefined,
      };
      let blocks: ContentBlock[] = [];
      let currentTextId: string | null = null;
      let currentThinkingId: string | null = null;
      const openBlocks = new Map<number, 'text' | 'thinking' | 'tool_use'>();
      let activeConversationId: string | null = null;
      let currentAssistantSeq = 0;
      let currentAssistantCreatedAt = Date.now();
      let lastPersistAt = 0;
      const PERSIST_INTERVAL_MS = 1000;
      /** True once a turn is live and its user/assistant rows are in the DB. */
      let turnLive = false;
      /** True between this turn's `result` and the next turn's first event. */
      let needsNewTurn = false;
      /**
       * Dedupe gate for refusal reporting. A refusal can surface twice for the
       * same turn — once via the partial-message `message_delta` stop_reason
       * and again on the final assistant message — so only the first sighting
       * per turn produces a block/event. Reset in beginNextTurn.
       */
      let refusalSeen = false;
      /**
       * Total tokens reported by the MOST RECENT model API call's `usage`
       * field (input + output + cache reads + cache creation). Within a
       * function-call loop the SDK makes one API call per turn, and each
       * assistant message carries its own usage — only the LAST one
       * represents the live context-window state. The cumulative
       * `result.modelUsage` aggregates across the whole loop and double-
       * counts the shared prefix every iteration, so we ignore it here and
       * trust the per-message usage instead.
       */
      let lastAssistantApiUsageTotal: number | null = null;

      // Defensively close any text/thinking block that's still marked
      // streaming. The Anthropic stream emits content_block_stop in normal
      // flow, but if the model jumps straight to a tool_use or starts a new
      // turn, the prior block can be left with streaming:true and the UI
      // shows a stuck blinking cursor. Call this at every transition.
      const closeOpenInlineBlocks = () => {
        if (currentTextId) {
          const blk = blocks.find(
            (b): b is TextBlock => b.type === 'text' && b.id === currentTextId,
          );
          if (blk && blk.streaming) {
            blk.streaming = false;
            send({ type: 'text_stop' });
          }
          currentTextId = null;
        }
        if (currentThinkingId) {
          const blk = blocks.find(
            (b): b is ThinkingBlock =>
              b.type === 'thinking' && b.id === currentThinkingId,
          );
          if (blk && blk.streaming) {
            blk.streaming = false;
            send({ type: 'thinking_stop' });
          }
          currentThinkingId = null;
        }
      };

      /**
       * Record a safety-classifier refusal for the current turn: close any
       * open inline blocks, append a dedicated refusal block (NOT an error
       * block — the API treats refusals as successful responses), persist,
       * and notify the client so it renders the refusal component.
       */
      const emitRefusal = (
        category: string | null,
        explanation: string | null,
      ) => {
        if (refusalSeen) return;
        refusalSeen = true;
        closeOpenInlineBlocks();
        blocks.push({
          type: 'refusal',
          id: newBlockId(),
          model: resolvedModel,
          category,
          explanation,
        });
        persistAssistant();
        send({
          type: 'refusal',
          model: resolvedModel,
          category,
          explanation,
        });
      };

      const persistAssistant = () => {
        if (!activeConversationId || isCompactOp) return;
        if (!turnLive) return;
        upsertMessage({
          id: currentTurn.assistantMessageId,
          conversationId: activeConversationId,
          role: 'assistant',
          seq: currentAssistantSeq,
          createdAt: currentAssistantCreatedAt,
          blocks: [...blocks],
        });
        touchConversation(activeConversationId, Date.now());
        lastPersistAt = Date.now();
      };

      const persistAssistantThrottled = () => {
        if (Date.now() - lastPersistAt < PERSIST_INTERVAL_MS) return;
        persistAssistant();
      };

      const persistTurnUserMessage = () => {
        if (!activeConversationId || isCompactOp) return;
        const userBlocks: ContentBlock[] = [];
        if (currentTurn.userImages && currentTurn.userImages.length > 0) {
          userBlocks.push(...currentTurn.userImages);
        }
        if (currentTurn.prompt) {
          userBlocks.push({ type: 'text', id: newBlockId(), text: currentTurn.prompt });
        }
        const userSeq = nextMessageSeq(activeConversationId);
        upsertMessage({
          id: currentTurn.userMessageId,
          conversationId: activeConversationId,
          role: 'user',
          seq: userSeq,
          createdAt: Date.now(),
          blocks: userBlocks,
        });
        currentAssistantSeq = userSeq + 1;
        currentAssistantCreatedAt = Date.now();
        upsertMessage({
          id: currentTurn.assistantMessageId,
          conversationId: activeConversationId,
          role: 'assistant',
          seq: currentAssistantSeq,
          createdAt: currentAssistantCreatedAt,
          blocks: [],
        });
      };

      // ===== Input queue (drives the SDK's AsyncIterable prompt) =====
      type InputQueueItem = { meta: TurnMeta; sdk: SdkUserMessage };
      const inputQueue: InputQueueItem[] = [];
      /**
       * Turn metadata yielded to the SDK but not yet rolled into `currentTurn`
       * by the handler. The handler shifts this whenever it begins a new turn.
       * Kept in FIFO order — same order the SDK consumes from `inputQueue`.
       */
      const pendingTurnMetas: TurnMeta[] = [];
      let inputResolve: (() => void) | null = null;
      let inputClosed = false;
      let closingTimer: NodeJS.Timeout | null = null;
      let yieldCount = 0;

      const wakeInput = () => {
        const r = inputResolve;
        if (!r) return;
        inputResolve = null;
        r();
      };

      const enqueueInput = (item: InputQueueItem): InjectResult => {
        if (inputClosed) return { ok: false, reason: 'stream-closing' };
        inputQueue.push(item);
        if (closingTimer) {
          clearTimeout(closingTimer);
          closingTimer = null;
        }
        wakeInput();
        return { ok: true };
      };

      const closeInputNow = () => {
        if (inputClosed) return;
        inputClosed = true;
        if (closingTimer) {
          clearTimeout(closingTimer);
          closingTimer = null;
        }
        wakeInput();
      };

      const scheduleIdleClose = () => {
        if (inputClosed) return;
        if (inputQueue.length > 0) return;
        if (closingTimer) return;
        closingTimer = setTimeout(() => {
          closingTimer = null;
          if (inputClosed) return;
          if (inputQueue.length > 0) return;
          inputClosed = true;
          wakeInput();
        }, POST_TURN_GRACE_MS);
      };

      // Seed with the initial turn. Generator yields it on its first `next()`.
      const firstImageContent = buildImageContentBlocks(images);
      const firstUserImages = buildUserImageBlocks(images);
      inputQueue.push({
        meta: {
          turnIndex: -1, // assigned at yield time
          userMessageId,
          assistantMessageId,
          prompt,
          userImages: firstUserImages,
        },
        sdk: {
          type: 'user',
          message: {
            role: 'user',
            content: buildSdkUserMessageContent(prompt, firstImageContent),
          },
          parent_tool_use_id: null,
          session_id: '',
        },
      });

      // ===== Registry hookup so /api/chat/inject can push messages here =====
      const unregister = isCompactOp
        ? () => {}
        : registerActiveStream(streamId, {
            push: (injectReq: InjectRequest): InjectResult => {
              const imageContent = buildImageContentBlocks(injectReq.images);
              const userImages =
                injectReq.userImages ?? buildUserImageBlocks(injectReq.images);
              const meta: TurnMeta = {
                turnIndex: -1,
                userMessageId: injectReq.userMessageId,
                assistantMessageId: injectReq.assistantMessageId,
                prompt: injectReq.prompt,
                userImages,
              };
              return enqueueInput({
                meta,
                sdk: {
                  type: 'user',
                  message: {
                    role: 'user',
                    content: buildSdkUserMessageContent(
                      injectReq.prompt,
                      imageContent,
                    ),
                  },
                  parent_tool_use_id: null,
                  session_id: '',
                },
              });
            },
          });

      // ===== Generator: pulls from inputQueue, only publishes metadata =====
      async function* promptIterable(): AsyncGenerator<SdkUserMessage> {
        while (true) {
          if (req.signal.aborted) return;
          if (inputQueue.length > 0) {
            const item = inputQueue.shift()!;
            const turnIndex = yieldCount;
            yieldCount += 1;
            pendingTurnMetas.push({ ...item.meta, turnIndex });
            yield item.sdk;
            continue;
          }
          if (inputClosed) return;
          await new Promise<void>((r) => {
            inputResolve = r;
          });
        }
      }

      /**
       * Roll forward to the next turn that's already been yielded to the SDK.
       * Called by the message handler at the first event of a new turn (and
       * for the first turn, by initConversation once we have a session_id).
       */
      const beginNextTurn = () => {
        if (pendingTurnMetas.length === 0) return;
        const next = pendingTurnMetas.shift()!;
        // Flush the previous turn's final state, if any.
        if (turnLive) {
          closeOpenInlineBlocks();
          persistAssistant();
          send({
            type: 'message_complete',
            assistantMessageId: currentTurn.assistantMessageId,
          });
        }
        // Fresh per-turn state.
        blocks = [];
        currentTextId = null;
        currentThinkingId = null;
        openBlocks.clear();
        lastPersistAt = 0;
        refusalSeen = false;
        currentTurn = next;
        turnLive = false;
        if (activeConversationId) {
          persistTurnUserMessage();
          turnLive = true;
        }
        send({
          type: 'turn_started',
          turnIndex: next.turnIndex,
          userMessageId: next.userMessageId,
          assistantMessageId: next.assistantMessageId,
          prompt: next.prompt,
          images: next.userImages,
        });
        needsNewTurn = false;
      };

      const initConversation = (sid: string) => {
        if (activeConversationId) return;
        const now = Date.now();
        ensureConversation(sid, cwd, now);
        activeConversationId = sid;

        if (isCompactOp) return;

        // First turn — the generator has already yielded once before any SDK
        // events arrived, so pendingTurnMetas[0] is the initial turn.
        setConversationTitle(sid, makeTitle(prompt));
        beginNextTurn();
      };

      try {
        // Compact slash commands stay one-shot — they don't accept injects
        // and the SDK expects a string for the /compact alias.
        const promptInput = isCompactOp
          ? prompt
          : (promptIterable() as unknown as Parameters<
              typeof query
            >[0]['prompt']);

        const parsedCwd = parseCwd(cwd);
        const isRemote = parsedCwd.kind === 'ssh';
        // SDK requires a real local cwd; use the user's home for remote
        // workspaces — none of the local file tools will be active anyway.
        const sdkCwd = isRemote ? os.homedir() : cwd;
        const envBlock = isRemote
          ? await buildSshEnvBlock(cwd)
          : buildLocalEnvBlock(cwd);
        const remoteMcp = isRemote ? createRemoteMcpServer({ workspaceCwd: cwd }) : null;
        const remoteToolsToBlock = [
          'Bash',
          'BashOutput',
          'KillShell',
          'Read',
          'Write',
          'Edit',
          'NotebookEdit',
          'Glob',
          'Grep',
          'LS',
          'Ls',
        ];

        send({ type: 'stream_ready', streamId });

        // Read fresh per session so in-app prompt edits apply immediately.
        const corePrefix = readSystemPrompt();
        const queryInstance = query({
          prompt: promptInput,
          options: {
            cwd: sdkCwd,
            model: resolvedModel,
            thinking: sdkThinking,
            effort,
            includePartialMessages: true,
            tools: { type: 'preset', preset: 'claude_code' },
            ...(isRemote ? { disallowedTools: remoteToolsToBlock } : {}),
            ...(remoteMcp ? { mcpServers: { remote: remoteMcp } } : {}),
            ...(mode && mode !== 'default' ? { permissionMode: mode } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            systemPrompt: corePrefix ? `${corePrefix}\n\n${envBlock}` : envBlock,
            env: { ...process.env },
            pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH || 'claude',
            canUseTool: async (toolName, input, opts) => {
              if (toolName !== 'AskUserQuestion') {
                return { behavior: 'allow', updatedInput: input };
              }
              send({ type: 'awaiting_question', toolUseId: opts.toolUseID, input });
              try {
                const answers: Answers = await awaitAnswers(
                  opts.toolUseID,
                  opts.signal,
                );
                send({
                  type: 'question_answered',
                  toolUseId: opts.toolUseID,
                  answers,
                });
                return {
                  behavior: 'allow',
                  updatedInput: { ...input, answers },
                };
              } catch (err) {
                return {
                  behavior: 'deny',
                  message:
                    err instanceof Error
                      ? `User question cancelled: ${err.message}`
                      : 'User question cancelled',
                };
              }
            },
          },
        });

        let sessionEmitted = false;

        // ===== Plan-usage meter (the SDK's /usage command) =====
        // Fetched after every function-calling loop so the top-bar meter
        // shows real percentages like Claude Code's /usage dialog. The
        // control request is experimental — failures are silently dropped
        // and the meter keeps its last reading.
        let usageFetchInFlight: Promise<void> | null = null;
        const fetchPlanUsage = () => {
          if (usageFetchInFlight) return; // one in flight; next loop refreshes
          usageFetchInFlight = (async () => {
            try {
              const data =
                await queryInstance.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
              const rl = data.rate_limits;
              if (!data.rate_limits_available || !rl) return;
              const win = (
                w: { utilization: number | null; resets_at: string | null } | null | undefined,
              ) =>
                w
                  ? {
                      utilization: w.utilization,
                      resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
                    }
                  : w;
              send({
                type: 'usage',
                fiveHour: win(rl.five_hour),
                sevenDay: win(rl.seven_day),
                sevenDayOpus: win(rl.seven_day_opus),
                sevenDaySonnet: win(rl.seven_day_sonnet),
                extraUsage: rl.extra_usage
                  ? {
                      isEnabled: rl.extra_usage.is_enabled,
                      utilization: rl.extra_usage.utilization,
                      usedCredits: rl.extra_usage.used_credits,
                      monthlyLimit: rl.extra_usage.monthly_limit,
                    }
                  : rl.extra_usage,
              });
            } catch {
              // Experimental control request — older CLIs reject it, and the
              // transport may already be tearing down. Keep the last reading.
            } finally {
              usageFetchInFlight = null;
            }
          })();
        };

        for await (const message of queryInstance) {
          if (req.signal.aborted) {
            try {
              await queryInstance.interrupt();
            } catch {
              /* ignore */
            }
            break;
          }

          if (
            !sessionEmitted &&
            'session_id' in (message as AnyRecord) &&
            (message as AnyRecord).session_id
          ) {
            const sid = String((message as AnyRecord).session_id);
            sessionEmitted = true;
            initConversation(sid);
            send({ type: 'session', sessionId: sid });
            // Populate the usage meter as soon as the session is live —
            // don't make the user wait for the first loop to finish.
            fetchPlanUsage();
          }

          // Roll into the next turn at the first event we see after a
          // `result`. By that point the generator has yielded (synchronously,
          // inside the SDK's pull), so pendingTurnMetas will have the new
          // turn's metadata.
          if (needsNewTurn && pendingTurnMetas.length > 0) {
            beginNextTurn();
          }

          // Compact boundary system event: emitted by the SDK when /compact
          // (or auto-compact) finishes. Persist it as a system message and
          // forward to client to render the divider.
          if (
            message.type === 'system' &&
            (message as AnyRecord & { subtype?: string }).subtype === 'compact_boundary'
          ) {
            const meta =
              (asRecord((message as AnyRecord).compact_metadata) as
                | {
                    trigger?: 'manual' | 'auto';
                    pre_tokens?: number;
                    post_tokens?: number;
                    duration_ms?: number;
                  }
                | null) ?? null;
            const trigger: 'manual' | 'auto' =
              meta?.trigger === 'auto' ? 'auto' : isCompactOp ? 'manual' : 'auto';
            const compactBlock: CompactBoundaryBlock = {
              type: 'compact_boundary',
              id: newBlockId(),
              trigger,
              preTokens: meta?.pre_tokens,
              postTokens: meta?.post_tokens,
              durationMs: meta?.duration_ms,
            };
            const sysMessageId = newSystemMessageId();
            if (activeConversationId) {
              const seq = nextMessageSeq(activeConversationId);
              upsertMessage({
                id: sysMessageId,
                conversationId: activeConversationId,
                role: 'system',
                seq,
                createdAt: Date.now(),
                blocks: [compactBlock],
              });
              touchConversation(activeConversationId, Date.now());
            }
            send({
              type: 'compact_boundary',
              messageId: sysMessageId,
              trigger,
              preTokens: meta?.pre_tokens,
              postTokens: meta?.post_tokens,
              durationMs: meta?.duration_ms,
            });
            continue;
          }

          // Account-level subscription usage (claude.ai plans). Forward to the
          // client so the top-bar usage meter stays current. Not persisted —
          // it's a live gauge, not conversation content.
          if ((message as AnyRecord).type === 'rate_limit_event') {
            const info = asRecord((message as AnyRecord).rate_limit_info);
            if (info) {
              const status = asString(info.status);
              if (
                status === 'allowed' ||
                status === 'allowed_warning' ||
                status === 'rejected'
              ) {
                const rawReset = Number(info.resetsAt);
                send({
                  type: 'rate_limit',
                  status,
                  utilization:
                    typeof info.utilization === 'number'
                      ? info.utilization
                      : undefined,
                  rateLimitType: asString(info.rateLimitType) ?? undefined,
                  // Normalize to epoch ms — the wire value is epoch seconds.
                  resetsAt: Number.isFinite(rawReset)
                    ? rawReset < 1e12
                      ? rawReset * 1000
                      : rawReset
                    : undefined,
                  isUsingOverage:
                    typeof info.isUsingOverage === 'boolean'
                      ? info.isUsingOverage
                      : undefined,
                });
              }
            }
            continue;
          }

          if (message.type === 'stream_event') {
            const event = asRecord((message as AnyRecord).event);
            if (!event) continue;
            const evType = event.type as string;

            if (evType === 'message_delta') {
              // The partial-message path surfaces the refusal first: the
              // message_delta's stop_reason flips to "refusal" with the
              // classifier verdict in stop_details. Detect it here so the
              // refusal component renders the moment the stream ends, not
              // after the final assistant message round-trips.
              const delta = asRecord(event.delta);
              if (delta && asString(delta.stop_reason) === 'refusal') {
                const details = asRecord(delta.stop_details);
                emitRefusal(
                  asString(details?.category),
                  asString(details?.explanation),
                );
              }
              continue;
            }
            if (evType === 'message_start') {
              closeOpenInlineBlocks();
              openBlocks.clear();
              continue;
            }
            if (evType === 'message_stop') {
              closeOpenInlineBlocks();
              openBlocks.clear();
              continue;
            }
            if (evType === 'content_block_start') {
              const idx = Number(event.index);
              const block = asRecord(event.content_block);
              const bt = block?.type;
              if (bt === 'text') {
                closeOpenInlineBlocks();
                openBlocks.set(idx, 'text');
                currentTextId = newBlockId();
                blocks.push({ type: 'text', id: currentTextId, text: '', streaming: true });
                send({ type: 'text_start' });
              } else if (bt === 'thinking') {
                closeOpenInlineBlocks();
                openBlocks.set(idx, 'thinking');
                currentThinkingId = newBlockId();
                blocks.push({
                  type: 'thinking',
                  id: currentThinkingId,
                  text: '',
                  streaming: true,
                });
                send({ type: 'thinking_start' });
              } else if (bt === 'tool_use') {
                closeOpenInlineBlocks();
                openBlocks.set(idx, 'tool_use');
                // Pre-render the tool block as soon as the model commits to a
                // tool name + id, well before the JSON input is fully
                // streamed. The UI shows a loading shell so big Edit/Write
                // calls don't sit silently for tens of seconds.
                const toolUseId = asString(block?.id) ?? '';
                const toolName = asString(block?.name) ?? '';
                if (toolUseId) {
                  const exists = blocks.some(
                    (b) => b.type === 'tool_use' && b.toolUseId === toolUseId,
                  );
                  if (!exists) {
                    blocks.push({
                      type: 'tool_use',
                      id: newBlockId(),
                      toolUseId,
                      name: toolName,
                      input: {},
                      streaming: true,
                    });
                    send({ type: 'tool_use_start', toolUseId, name: toolName });
                    persistAssistantThrottled();
                  }
                }
              }
              continue;
            }
            if (evType === 'content_block_delta') {
              const delta = asRecord(event.delta);
              if (!delta) continue;
              if (delta.type === 'text_delta') {
                const t = asString(delta.text);
                if (t) {
                  if (currentTextId) {
                    const blk = blocks.find(
                      (b): b is TextBlock => b.type === 'text' && b.id === currentTextId,
                    );
                    if (blk) blk.text += t;
                  }
                  send({ type: 'text_delta', text: t });
                }
              } else if (delta.type === 'thinking_delta') {
                const t = asString(delta.thinking);
                if (t) {
                  if (currentThinkingId) {
                    const blk = blocks.find(
                      (b): b is ThinkingBlock =>
                        b.type === 'thinking' && b.id === currentThinkingId,
                    );
                    if (blk) blk.text += t;
                  }
                  send({ type: 'thinking_delta', text: t });
                }
              }
              continue;
            }
            if (evType === 'content_block_stop') {
              const idx = Number(event.index);
              const kind = openBlocks.get(idx);
              openBlocks.delete(idx);
              if (kind === 'text') {
                if (currentTextId) {
                  const blk = blocks.find(
                    (b): b is TextBlock => b.type === 'text' && b.id === currentTextId,
                  );
                  if (blk) blk.streaming = false;
                  currentTextId = null;
                }
                send({ type: 'text_stop' });
                persistAssistantThrottled();
              } else if (kind === 'thinking') {
                if (currentThinkingId) {
                  const blk = blocks.find(
                    (b): b is ThinkingBlock =>
                      b.type === 'thinking' && b.id === currentThinkingId,
                  );
                  if (blk) blk.streaming = false;
                  currentThinkingId = null;
                }
                send({ type: 'thinking_stop' });
                persistAssistantThrottled();
              }
              continue;
            }
            continue;
          }

          if (message.type === 'assistant') {
            const inner = asRecord((message as AnyRecord).message);
            // Pull this specific API call's token usage off the BetaMessage
            // shape (`input_tokens`, `output_tokens`, `cache_*_input_tokens`).
            // Each event REPLACES the reading — never accumulates — so the
            // meter always shows the LAST message's footprint, i.e. the live
            // context window, not the sum of every call in the loop.
            // Subagent (Task) calls run in their own separate context, so
            // their usage must not clobber this conversation's reading.
            const usage = asRecord(inner?.usage);
            if (usage && (message as AnyRecord).parent_tool_use_id == null) {
              const inputTokens = Number(usage.input_tokens) || 0;
              const outputTokens = Number(usage.output_tokens) || 0;
              const cacheRead = Number(usage.cache_read_input_tokens) || 0;
              const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
              const callTotal =
                inputTokens + outputTokens + cacheRead + cacheCreate;
              if (callTotal > 0 && callTotal !== lastAssistantApiUsageTotal) {
                lastAssistantApiUsageTotal = callTotal;
                // Push the fresh reading immediately — the meter tracks the
                // loop live instead of jumping once at the end.
                send({
                  type: 'token_budget',
                  used: callTotal,
                  total: 1_000_000,
                });
              }
            }
            // Belt-and-braces refusal detection on the final assistant
            // message — covers any path where the partial message_delta was
            // missed (emitRefusal dedupes per turn, so double-sighting is a
            // no-op). A refusal is a SUCCESSFUL response, not an error.
            if (asString(inner?.stop_reason) === 'refusal') {
              const details = asRecord(inner?.stop_details);
              emitRefusal(
                asString(details?.category),
                asString(details?.explanation),
              );
            }
            const content = inner?.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                const r = asRecord(part);
                if (!r) continue;
                if (r.type === 'tool_use') {
                  const id = asString(r.id) ?? '';
                  if (!id) continue;
                  const toolName = asString(r.name) ?? 'tool';
                  const augmented = augmentToolInput(toolName, r.input ?? null, cwd);
                  const existingIdx = blocks.findIndex(
                    (b) => b.type === 'tool_use' && b.toolUseId === id,
                  );
                  if (existingIdx >= 0) {
                    const orig = blocks[existingIdx] as ToolUseBlock;
                    if (orig.streaming || !orig.input || (typeof orig.input === 'object' && Object.keys(orig.input as object).length === 0)) {
                      blocks[existingIdx] = {
                        ...orig,
                        name: toolName,
                        input: augmented,
                        streaming: false,
                      };
                      send({
                        type: 'tool_use_input',
                        toolUseId: id,
                        name: toolName,
                        input: augmented,
                      });
                      persistAssistantThrottled();
                    }
                  } else {
                    closeOpenInlineBlocks();
                    blocks.push({
                      type: 'tool_use',
                      id: newBlockId(),
                      toolUseId: id,
                      name: toolName,
                      input: augmented,
                    });
                    send({
                      type: 'tool_use',
                      toolUseId: id,
                      name: toolName,
                      input: augmented,
                    });
                    persistAssistantThrottled();
                  }
                }
              }
            }
            continue;
          }

          if (message.type === 'user') {
            const inner = asRecord((message as AnyRecord).message);
            const content = inner?.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                const r = asRecord(part);
                if (!r || r.type !== 'tool_result') continue;
                const toolUseId = asString(r.tool_use_id) ?? '';
                if (!toolUseId) continue;
                const text = flattenToolResultContent(r.content);
                const isError = Boolean(r.is_error);
                const idx = blocks.findIndex(
                  (b) => b.type === 'tool_use' && b.toolUseId === toolUseId,
                );
                if (idx >= 0) {
                  const orig = blocks[idx] as ToolUseBlock;
                  blocks[idx] = {
                    ...orig,
                    result: { content: text, isError },
                  };
                }
                send({ type: 'tool_result', toolUseId, content: text, isError });
                persistAssistantThrottled();
              }
            }
            continue;
          }

          if (message.type === 'result') {
            // Final consistency send: the LAST model API call's footprint.
            // Never the SDK's `modelUsage` — that sums every iteration of
            // the function-call loop (double-counting the shared prefix)
            // and would blow the meter past the real context size.
            if (lastAssistantApiUsageTotal != null) {
              send({
                type: 'token_budget',
                used: lastAssistantApiUsageTotal,
                total: 1_000_000,
              });
            }
            // Refresh the plan-usage meter after every loop — the /usage
            // numbers only move once a turn has burned tokens. Fire-and-
            // forget so turn promotion below is never delayed.
            fetchPlanUsage();
            // Mark the current turn done.
            closeOpenInlineBlocks();
            persistAssistant();
            needsNewTurn = true;
            // If the user already injected the next turn (which is the
            // common case — `pendingTurnMetas` is populated synchronously
            // when the generator yields on inject), promote it RIGHT NOW.
            // We can't rely on "fire on the next event we see after result"
            // because the CLI sometimes merges the queued user message into
            // a single combined response and emits exactly one `result` —
            // meaning no follow-up event ever arrives to drive the
            // promotion. Doing it here guarantees the client gets
            // `turn_started` (so the queue clears and the user message
            // appears in chat) regardless of how the CLI batches turns.
            if (pendingTurnMetas.length > 0 && !isCompactOp) {
              beginNextTurn();
            }
            scheduleIdleClose();
            continue;
          }
        }

        // Loop exited — either input was closed cleanly or we hit abort.
        // Drain any pending turn metas that never got promoted. This is the
        // safety net for the case where the CLI exits without ever emitting
        // an event for a message we already pushed onto the input stream
        // (e.g. abort mid-pull, or a merged-response shape where `result`
        // covers more than one queued user message). Each `beginNextTurn`
        // closes the previous turn with `message_complete` and opens the
        // next one with `turn_started`, so the client can clear the queue
        // and show the user message even when the assistant turn is empty.
        while (pendingTurnMetas.length > 0 && !isCompactOp) {
          beginNextTurn();
        }
        // Close out whichever turn is still considered live.
        if (turnLive && !isCompactOp) {
          closeOpenInlineBlocks();
          persistAssistant();
          send({
            type: 'message_complete',
            assistantMessageId: currentTurn.assistantMessageId,
          });
        }
        // Give an in-flight /usage fetch a bounded chance to land before the
        // stream closes — the post-loop reading is the one the user wants.
        if (usageFetchInFlight) {
          await Promise.race([
            usageFetchInFlight,
            new Promise((r) => setTimeout(r, 2_000)),
          ]);
        }
        send({ type: 'complete' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (activeConversationId && turnLive && !isCompactOp) {
          blocks.push({ type: 'error', id: newBlockId(), text: `Error: ${message}` });
          persistAssistant();
        }
        send({ type: 'error', error: message });
      } finally {
        unregister();
        closeInputNow();
        if (!controllerClosed) {
          controllerClosed = true;
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
