import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { NextRequest } from 'next/server';
import { readSystemPrompt } from '@/server/systemPrompt';
import {
  agentFinished,
  agentStarted,
  clearConversation,
  describeLiveAgents,
} from '@/server/liveAgents';
import { readNotebook, writeNotebook } from '@/server/notebook';
import { createNotebookMcpServer } from '@/server/notebookTools';
import {
  ensureConversation,
  getConversationBackend,
  nextMessageSeq,
  sdkTranscriptPath,
  setConversationTitle,
  touchConversation,
  upsertMessage,
} from '@/server/conversations';
import { repairTranscript } from '@/server/transcriptRepair';
import { awaitAnswers, type Answers } from '@/server/pendingQuestions';
import {
  registerActiveStream,
  type InjectRequest,
  type InjectResult,
} from '@/server/activeChatStreams';
import { parseCwd } from '@/lib/cwd';
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
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { psEncode, psLit, toWinPath, type RemotePlatform } from '@/server/remoteShell';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';
import {
  DEFAULT_MODEL_ID,
  getDefaultEffort,
  getModelInfo,
  getProvider,
  getWireModelId,
  isValidEffort,
  isValidModelId,
  supportsEffortLadder,
  type EffortLevel,
  type ModelId,
} from '@/lib/models';
import {
  MissingProviderCredentialError,
  buildProviderEnv,
} from '@/server/providers';
import type {
  CompactBoundaryBlock,
  ContentBlock,
  ImageAttachmentBlock,
  ImageMediaType,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '@/lib/types';
import { encodeNDJSON, type StreamEvent } from '@/lib/streamEvents';
import { augmentToolInput } from '@/server/toolInputAugment';
import { runOpencodeStream } from '@/server/opencode/stream';
import {
  defaultBackendForModel,
  getBackendInfo,
  isValidBackend,
  supportsBackend,
  type ChatBackend,
} from '@/lib/backends';

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
  | {
      type: 'enabled';
      display?: 'summarized' | 'omitted';
      budgetTokens?: number;
    };

function thinkingForModel(model: ModelId): SdkThinking {
  const provider = getProvider(model);
  if (provider === 'deepseek' || provider === 'zai') {
    // Both document exactly {"type": "enabled" | "disabled"} and nothing more.
    // Neither has an adaptive mode, a thinking budget, or a `display` control:
    //
    // - Z.AI's depth knob is `reasoning_effort` (max | high | ... ), which
    //   defaults to `max` — the level Z.AI itself recommends for coding. It is
    //   an OpenAI-style top-level field the CLI never emits, so `max` is what
    //   we get, and it is what we want.
    // - DeepSeek's equivalent is likewise `reasoning_effort`, also unreachable
    //   through the CLI.
    //
    // Sending Anthropic's `budgetTokens` here is measurably inert (a 100-token
    // budget produced MORE thinking than omitting the field), so it is left
    // off rather than shipped as undocumented noise.
    return { type: 'enabled' };
  }
  if (provider === 'openrouter') {
    // OpenRouter normalises `thinking` onto whichever upstream model serves the
    // request, and that upstream is not fixed — the budget is the one portable
    // way to ask for a comparable amount of reasoning across hosts.
    return { type: 'enabled', budgetTokens: 16_000 };
  }
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
/**
 * Grace applied after a SYNTHETIC no-op turn instead of the 150 ms above.
 *
 * On resume the CLI can answer instantly with a fabricated assistant message
 * ("No response requested.", model `<synthetic>`, zero tokens) and emit its
 * `result` before it has actually started the real turn. On a very large
 * conversation the real turn only begins once the prompt cache is rebuilt,
 * which takes minutes — far longer than the normal grace. Closing the input on
 * that fake `result` kills the CLI mid-rebuild and the user gets no answer at
 * all, so a synthetic turn buys a much longer window. Bounded (not infinite) so
 * a genuinely dead session still releases the stream; Stop cancels it sooner.
 */
const SYNTHETIC_TURN_GRACE_MS = 10 * 60_000;

/**
 * Grace applied when the LAST background task reports in while the model is
 * idle — again instead of the 150 ms above.
 *
 * `task_notification` is not the end of the work, it is the thing that wakes
 * the model to react to it: the CLI starts a fresh turn to read the agent's
 * result, and that turn calls tools. Those calls are permissioned through
 * `canUseTool` on this stream, so collapsing to the short grace the instant the
 * notification lands closes the input out from under the turn it just caused.
 * The tool call then has no permission channel and the CLI falls back to its
 * standard refusal — "The user doesn't want to take this action right now" —
 * which is indistinguishable from a real rejection, so it reads as the app
 * denying tools by itself while the user pressed nothing.
 *
 * Observed with four `Agent` subagents: all four completed, and the first two
 * tool calls of the waking turn (an MCP notebook write, then a ToolSearch) were
 * both refused. Bounded, and any later `result` re-arms the normal grace.
 */
const TASK_WAKE_GRACE_MS = 10 * 60_000;
/**
 * Grace applied while a BACKGROUND TASK (async subagent, backgrounded Bash) is
 * still running.
 *
 * The Agent tool can launch a subagent asynchronously: the tool_result comes
 * back immediately ("Async agent launched successfully") and the parent's turn
 * ends right after, while the agent keeps working in its own context. Closing
 * the input on that `result` tears the CLI down mid-flight, and every tool the
 * agent then calls dies with `Tool permission request failed: AbortError:
 * Stream closed` — because `canUseTool` lives on this very stream. That is
 * exactly why spawning agents "didn't work" here.
 *
 * So while tasks are outstanding the stream is held open on a long grace and
 * only released once the last one reports `task_notification`. Bounded so a
 * task that never settles still frees the stream; Stop cancels it sooner.
 */
const AGENT_TASK_GRACE_MS = 30 * 60_000;

/**
 * The same idea for a backgrounded shell, but far shorter.
 *
 * A shell is not an agent: it makes no tool calls, so it needs no permission
 * channel and nothing about it requires this stream. The only reason to wait
 * at all is that the shell is a child of the CLI process and dies with it, so
 * a brief hold lets a follow-up message arrive and keep it alive.
 *
 * It must not be the agent grace. A backgrounded server (`python3 -m
 * http.server`, a dev server) never exits, so it never reports completion, so
 * the grace can never be cut short by the task settling — it burns the full
 * duration every single time. At 30 minutes that pinned a ~265 MB CLI process
 * for half an hour after the user had stopped talking, which on a 5.6 GB
 * machine is the difference between paging and not.
 */
const BACKGROUND_SHELL_GRACE_MS = 90_000;

/**
 * Task types the SDK registers for agent-shaped work, which does route tool
 * calls back through `canUseTool` on this stream and therefore does need it
 * held open. Everything else (`local_bash`, monitors) does not.
 */
const AGENT_TASK_TYPES = new Set([
  'local_agent',
  'in_process_teammate',
  'remote_agent',
  // A workflow is a script that dispatches its own agents, so it holds the
  // same dependency on this stream that a bare subagent does.
  'local_workflow',
]);

/**
 * Tools that start a subagent. Both names are listed because the CLI has
 * shipped this tool under each, and blocking only the current one would let a
 * version bump quietly reopen nested spawning.
 */
const SUBAGENT_SPAWN_TOOLS = new Set(['Agent', 'Task']);

const NO_NESTED_SPAWN_RULE =
  'You are a subagent. You CANNOT start subagents of your own — the Agent and ' +
  'Task tools are blocked for you, and calling one will be denied. Do the work ' +
  'yourself. If it is genuinely too large to finish alone, do as much as you ' +
  'can and say plainly in your result what still needs splitting up; the main ' +
  'assistant will dispatch that.';

/**
 * Stops the subagent tree at one level deep.
 *
 * A recorded session issued 5 `Agent` calls and ended up running 30 agents —
 * 5 → 10 → 15 across three levels, 19 live at once. No agent can see its
 * siblings or its children, so no individual decision looked wrong, and the
 * depth-2 and depth-3 spawns never appeared as a tool call in the conversation
 * at all: they happen inside subagent transcripts the UI never renders. Depth
 * is the only axis that can be capped from outside, and hooks are the only
 * place that sees it.
 *
 * `canUseTool` cannot do this job. Verified against the real CLI: it is
 * consulted only for calls that would otherwise prompt, so an `Agent` call
 * never reaches it — under `bypassPermissions`, which is what this app runs,
 * nothing reaches it at all. A `PreToolUse` hook fires either way.
 *
 * Two layers, because they fail differently:
 *   - SubagentStart injects the rule into the subagent's context, so it never
 *     forms the intent. Additive: it does not replace the tuned agent prompt.
 *   - PreToolUse denies the call outright if it tries anyway.
 *
 * `agent_id` is documented as present ONLY when a hook fires from inside a
 * subagent — absent on the main thread — so the main conversation keeps its
 * full freedom to fan out.
 */
const NO_NESTED_SUBAGENT_HOOKS = {
  SubagentStart: [
    {
      hooks: [
        async () => ({
          hookSpecificOutput: {
            hookEventName: 'SubagentStart' as const,
            additionalContext: NO_NESTED_SPAWN_RULE,
          },
        }),
      ],
    },
  ],
  PreToolUse: [
    {
      hooks: [
        async (input: { tool_name?: string; agent_id?: string }) => {
          if (!input.agent_id || !SUBAGENT_SPAWN_TOOLS.has(input.tool_name ?? '')) {
            return { continue: true };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: NO_NESTED_SPAWN_RULE,
            },
          };
        },
      ],
    },
  ],
};

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
  /**
   * Throwaway chat: the conversation is created hidden from every listing and
   * deleted as soon as the client stops pointing at it. Only meaningful on the
   * turn that creates the conversation — the flag is fixed at creation.
   */
  ephemeral?: boolean;
  /**
   * Harness to run this conversation on. Honoured only when creating a
   * conversation — an existing one uses the backend stored against it.
   */
  backend?: string;
};

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

  let remotePlatform: RemotePlatform = 'posix';
  let remoteUname = '(remote uname unavailable)';
  let remoteDistro = '(unknown)';
  let remoteHostname = parsed.host;
  let remoteUser = parsed.user;
  let remoteHome = '~';
  let remoteGit = '(no git status — connection failed)';
  try {
    const host = await getHost(opts);
    remotePlatform = await host.platform().catch(() => 'posix' as RemotePlatform);
    remoteHome = (await host.homeDir().catch(() => '~')) || '~';

    if (remotePlatform === 'windows') {
      // Windows probes run through PowerShell (shell-agnostic, via -EncodedCommand).
      const winCwd = toWinPath(parsed.path);
      const setLoc = `Set-Location -LiteralPath ${psLit(winCwd)} -ErrorAction SilentlyContinue; `;
      const [osR, hostR, userR, gitBranchR, gitDirtyR] = await Promise.all([
        host
          .exec(psEncode('(Get-CimInstance Win32_OperatingSystem).Caption'))
          .catch(() => ({ stdout: '' })),
        host.exec(psEncode('$env:COMPUTERNAME')).catch(() => ({ stdout: '' })),
        host
          .exec(psEncode('[System.Environment]::UserName'))
          .catch(() => ({ stdout: '' })),
        host
          .exec(psEncode(`${setLoc}git rev-parse --abbrev-ref HEAD 2>$null`))
          .catch(() => ({ stdout: '' })),
        host
          .exec(
            psEncode(`${setLoc}(git status --porcelain 2>$null | Measure-Object -Line).Lines`),
          )
          .catch(() => ({ stdout: '' })),
      ]);
      remoteDistro = osR.stdout.trim() || 'Windows';
      remoteUname = remoteDistro;
      remoteHostname = hostR.stdout.trim() || remoteHostname;
      remoteUser = userR.stdout.trim() || remoteUser;
      const branch = gitBranchR.stdout.trim();
      if (branch && !/^fatal|not a git/i.test(branch)) {
        const dirty = parseInt(gitDirtyR.stdout.trim() || '0', 10) || 0;
        remoteGit =
          dirty > 0
            ? `branch \`${branch}\` (${dirty} modified file${dirty === 1 ? '' : 's'})`
            : `branch \`${branch}\` (clean)`;
      } else {
        remoteGit = 'not a git repository';
      }
    } else {
      // POSIX probes.
      const cd = `cd ${shellQuote(parsed.path)} 2>/dev/null;`;
      const [unameR, distroR, hostR, userR, gitBranchR, gitStatusR] = await Promise.all([
        host.exec('uname -a').catch(() => ({ stdout: '' })),
        host
          .exec(
            `sh -c "(. /etc/os-release 2>/dev/null && printf %s \\"$PRETTY_NAME\\") || uname -sr"`,
          )
          .catch(() => ({ stdout: '' })),
        host.exec('hostname').catch(() => ({ stdout: '' })),
        host.exec('whoami').catch(() => ({ stdout: '' })),
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
    }
  } catch (err) {
    remoteGit = `(probe failed: ${err instanceof Error ? err.message : 'unknown'})`;
  }

  // OS-specific working guidance the model must honour when driving the remote
  // tools — this is where the AI learns to write PowerShell vs bash.
  const platformGuidance =
    remotePlatform === 'windows'
      ? `This remote host is **Windows**. \`mcp__remote__bash\` runs your command in
**PowerShell** — write PowerShell/Windows commands (\`Get-ChildItem\`,
\`Get-Content\`, \`Select-String\`, \`Remove-Item\`, \`New-Item\`…), NOT
POSIX/bash (\`ls\`, \`cat\`, \`grep\`, \`rm\`). Remote file paths use Windows
form — \`C:\\Users\\you\\file\` or the equivalent \`/C:/Users/you/file\`. The
remote glob/grep/ls/read/write/edit tools are already OS-aware, so prefer them.`
      : `This remote host is POSIX (${remoteUname}); the remote tools use bash + GNU
coreutils. Remote paths are \`/\`-rooted.`;

  return `# Working environment (REMOTE via SSH)

You are operating on a remote host over SSH, and you can reach two machines.

**The remote host is where the work is.** The built-in Bash, Read, Write, Edit,
Glob, Grep, LS, NotebookEdit, BashOutput and KillShell tools are disabled in
this workspace — they would silently act on the wrong machine. Use
\`mcp__remote__bash\`, \`mcp__remote__read\`, \`mcp__remote__write\`,
\`mcp__remote__edit\`, \`mcp__remote__glob\`, \`mcp__remote__grep\` and
\`mcp__remote__ls\` instead. The workspace, the project and essentially
everything you are asked to do live there. This is the default for every
action unless there is a specific reason otherwise.

**You can also reach back to this UI's own host** with \`mcp__local__bash\`,
\`mcp__local__read\` and \`mcp__local__write\`, which run on ${os.hostname()}.
That is an escape hatch, not a second workspace. Use it when the task genuinely
concerns this machine — moving a file between the two, reading a local key or
config, driving a tool that only exists here, checking something about the
client side — and not otherwise. There are only three of them on purpose;
anything else you need on this machine, do through \`mcp__local__bash\`.

Because the same request can often be satisfied on either machine, name the one
you acted on when it is not obvious from context. If a path could plausibly
exist on both, say which side you meant before touching it.

${platformGuidance}

- Remote platform: ${remotePlatform === 'windows' ? 'Windows' : 'POSIX'}
- Remote workspace cwd: ${parsed.path}
- Remote URI: ${cwd}
- Remote host: ${remoteHostname} (${parsed.host}:${parsed.port})
- Remote user: ${remoteUser} (home ${remoteHome})
- Remote OS: ${remoteDistro}
- Remote kernel/version: ${remoteUname}
- Remote git: ${remoteGit}
- Local host (this UI's machine, reachable via mcp__local__*): ${os.hostname()} — home ${os.homedir()}, platform ${process.platform}
- Today's date (client local): ${localStr}
- Timestamp (UTC ISO): ${isoUtc}
- Unix epoch (ms): ${epochMs}
- Client time zone: ${tz}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * System-prompt block for the per-conversation notebook: tells the model the
 * tool exists and that it must use it proactively, and shows the current notes
 * inline so they're live context every turn. `notes` is the stored blob for
 * this conversation (empty for a brand-new one).
 */
function buildNotebookBlock(notes: string): string {
  const body = notes.trim() ? notes : '(empty)';
  return `# Notebook (private — this conversation only)

You have a \`notebook\` tool whose contents are shown below and re-injected here every turn. On your own initiative, record durable knowledge worth keeping — established facts, things you discovered and would otherwise have to re-derive, hard constraints and rules to honor, the user's preferences and conventions, and key decisions. Anything the user tells you to remember is a mandatory write. Record knowledge, not work: this is NOT a to-do list or task tracker — never put tasks, steps, or progress here. Keep it lean and current — a small reference, not an append-only dump: prune aggressively, deleting or rewriting notes the moment they go stale or stop being relevant.

Current notebook:
${body}`;
}

/**
 * How the model extends its OWN toolset with MCP servers.
 *
 * Same reasoning as the rendering block: a capability nobody describes is a
 * capability that never gets used. The `mcp` tools let the model install a
 * server on the machine it is working on and wire it into the harness in the
 * same turn — but three facts make that succeed or fail, and none of them are
 * discoverable from the tool schemas alone:
 *
 *   1. Configuration is per FOLDER, so what is live here is not what is live
 *      elsewhere, and adding a server does not disturb other work.
 *   2. New tools appear on the NEXT message, not this one. Without this the
 *      model calls the tool it just registered, gets "no such tool", and
 *      concludes the connection failed.
 *   3. Creative-app servers (Blender, Unreal, Godot) are BRIDGES to a running
 *      application over a local socket. They must run on the machine the app
 *      runs on, and the app must already be up with its addon enabled. This is
 *      the single most likely way a setup silently half-works.
 *
 * `toolPrefix` differs per engine — `mcp__mcp__` on the Agent SDK, `mcp_` on
 * OpenCode — so the block names tools the way this turn's engine will.
 */
function buildMcpBlock(opts: {
  cwd: string;
  isRemote: boolean;
  toolPrefix: string;
  attached: { name: string }[];
}): string {
  const p = opts.toolPrefix;
  const live =
    opts.attached.length > 0
      ? `Already connected in this folder: ${opts.attached
          .map((s) => `\`${s.name}\` (its tools are \`${s.name}_*\`)`)
          .join(', ')}. Use those directly — do not re-add them.`
      : 'No MCP servers are connected in this folder yet.';

  const where = opts.isRemote
    ? `This folder lives on a remote SSH host, so **\`ssh-stdio\` is the transport you want** — it
runs the server ON that host, where the files and applications actually are. You
do not need to pass \`host\`: it defaults to this folder's machine. Install or
verify the server first with \`mcp__remote__bash\`, then connect it.`
    : `This folder is local, so **\`local-stdio\`** runs the server on this machine. An
\`ssh-stdio\` server here needs an explicit \`host\` (an \`ssh://…\` workspace),
because there is no host to inherit.`;

  return `# Extending your own toolset (MCP)

You can add MCP servers to this session yourself, with \`${p}list\`,
\`${p}connect\`, \`${p}attach\`, \`${p}detach\`, \`${p}remove\`, and \`${p}test\`.

${live}

**Scope: per folder.** MCP servers are configured for a workspace folder, not
for a conversation. Anything you connect here is available to every future
conversation in \`${opts.cwd}\` and nowhere else. Server *definitions* are
shared globally, so \`${p}list\` may show servers configured in other folders —
\`${p}attach\` switches an existing one on here without redefining it.

**Timing: next message.** A newly connected server's tools are NOT callable in
the turn that connects it. Both engines build their tool map when a turn
starts. \`${p}connect\` returns the tool list it discovered, so use that to
confirm success, tell the user what arrived, and call the tools from your next
message. Do not retry the connect because the tool "isn't there" — it will not
be there until the turn ends.

${where}

**Transports.** \`ssh-stdio\` and \`local-stdio\` spawn a command and speak MCP
over its stdio — that covers almost everything (\`uvx …\`, \`npx -y …\`). Use
\`http\` only for a server that already listens on an HTTP endpoint, e.g. a
plugin that embeds its own MCP server. \`${p}test\` probes a command without
saving it, which is the cheap way to check a guess.

**Servers that drive a running application.** Many creative-tool MCP servers —
Blender, Unreal, Godot — are not self-contained. The command you run is a
BRIDGE that connects over a local TCP port to a plugin inside an application
that must already be running. Two consequences:

- The bridge must run on the SAME machine as the application. If Blender runs
  on the SSH host, the MCP server must be \`ssh-stdio\` on that host — a
  \`local-stdio\` copy here would start cleanly and then fail every call,
  because there is no Blender on this machine to talk to.
- The application-side plugin must be enabled and listening BEFORE the tools
  work. For Blender that is the BlenderMCP addon, enabled in Preferences and
  switched on from the BlenderMCP panel in the 3D viewport sidebar (\`N\`),
  which listens on TCP 9876; \`BLENDER_HOST\`/\`BLENDER_PORT\` in \`env\`
  override it. For Unreal it is the Python Editor Script Plugin with remote
  execution enabled, with the editor open.

So a connect that succeeds and lists tools proves the bridge started — not that
the application is reachable. If the tools then error with a connection
refusal, the app or its plugin is the thing to fix, and the user usually has to
do that part in the GUI. Say so plainly rather than reconnecting in a loop.

Tell the user what you connected and what it can do. Prefer \`${p}detach\` over
\`${p}remove\` when you are only tidying this folder — \`remove\` deletes the
definition everywhere, including other folders that may rely on it.`;
}

/**
 * What the chat UI can actually display.
 *
 * The model cannot see its own output, so a capability it is never told about
 * is a capability it never uses. Mermaid fences render as live diagrams here;
 * this block is what turns that from a feature into a habit. The syntax rules
 * are the ones that actually break real diagrams — a fence that fails to parse
 * degrades to a source dump, which is worse than the prose it replaced.
 */
function buildRenderingBlock(): string {
  return `# Rendering in this chat UI

Your replies render as GitHub-flavored Markdown. On top of that, a fenced code
block tagged \`mermaid\` is **rendered as a live diagram** rather than shown as
source:

\`\`\`mermaid
flowchart LR
  A[Request] --> B{In cache?}
  B -- hit --> C[Serve]
  B -- miss --> D[Fetch origin] --> C
\`\`\`

Use one when the shape of the answer *is* the answer: architecture and data
flow, call or dependency graphs, state machines, request sequences across
services, schemas and relationships, timelines, decision trees. A diagram beside
two sentences of prose beats either alone. Do not diagram what a single sentence
or a short list already makes clear — a diagram that only restates prose is
noise, and so is one nobody asked for on a quick factual answer.

Available diagram types: \`flowchart\`, \`sequenceDiagram\`, \`classDiagram\`,
\`stateDiagram-v2\`, \`erDiagram\`, \`journey\`, \`gantt\`, \`pie\`,
\`quadrantChart\`, \`requirementDiagram\`, \`gitGraph\`, \`mindmap\`,
\`timeline\`, \`sankey-beta\`, \`xychart-beta\`, \`block-beta\`, \`C4Context\`,
\`architecture-beta\`.

Syntax rules that actually bite — a diagram that fails to parse is shown to the
user as a failure card, so stay inside these:
- Quote any label containing punctuation, brackets, or slashes:
  \`A["fetch(url)"]\`, never \`A[fetch(url)]\`.
- Node ids are bare identifiers — no spaces, dots, or dashes. The readable text
  belongs in the label, not the id.
- Escape \`#\` and \`;\` inside labels as \`#35;\` and \`#59;\`.
- Use \`stateDiagram-v2\`, not the older \`stateDiagram\`.
- One diagram per fence, and no Markdown inside a fence.
- Keep to roughly 20 nodes. Split a bigger picture into several diagrams rather
  than one that renders as an unreadable hairball.

Rendering is strict-sanitized: \`click\` directives and raw HTML in labels are
stripped, so do not rely on them.`;
}

/**
 * What the model is not otherwise in a position to know about subagents.
 *
 * An agent sees only the calls it makes itself — never its siblings, never its
 * children, never a running total. Left uninformed it will judge each fan-out
 * on its own merits, which is how five reasonable-looking dispatches became
 * thirty live agents. This supplies the two facts it cannot observe: that the
 * nesting is now closed, and that the machine underneath is small.
 */
function buildAgentsBlock(nestedSpawnBlocked: boolean, live: string): string {
  // Only the Agent SDK path routes tool calls through canUseTool, so only it
  // can actually enforce the depth limit. Telling an engine that does not
  // enforce it that it is enforced would be a lie the model then plans around.
  const nesting = nestedSpawnBlocked
    ? `**Subagents cannot spawn subagents.** That is enforced, not advisory: they
are told so when they start, and the call is denied if they try anyway. So the
agents you dispatch ARE the whole tree, not its first level — they will do their
own work rather than delegating onward. If one decides its task needs splitting,
it reports that back and you decide.`
    : `**Do not let a subagent spawn its own subagents**, and do not spawn one
yourself if you are already a subagent. Nesting compounds invisibly: three
levels of a modest fan-out is dozens of live agents that nobody counted. Keep
the tree one level deep — if a subagent's task needs splitting, it should report
that back rather than delegate onward.`;

  // Snapshot, not a feed: the system prompt is fixed when the turn starts, so
  // this covers agents left over from earlier turns. Anything dispatched
  // during this turn the model already knows about, having called it itself.
  const running = live
    ? `\n${live}\n\nThat list is a snapshot from the start of this turn; agents you
start now are on top of it.\n`
    : '';

  return `# Subagents
${running}
Spawn as many as the work genuinely needs — no fixed limit. But size the fan-out
to the work, and be deliberate about it: apart from the snapshot above, nothing
reports how many agents are running. There is no global budget and no
back-pressure. The number you dispatch is the number that runs.

So dispatch deliberately. A handful of agents covering genuinely independent
parts of a real problem is the tool working as intended. A dozen spun up to read
around a topic is not research, it is fan-out for its own sake — it costs real
time and money, returns overlapping findings you then have to reconcile, and
buries the answer you were after. When one agent with a few searches would
answer the question, use one agent.

${nesting}

Agents are not free. Each one is a full model session with its own context and
its own tool calls, and they run concurrently on this machine — several agents
running shell commands at once will contend for its memory and disk.

# Background shells

\`run_in_background\` is for a command you intend to read back with
\`BashOutput\` — not a way to launch something and walk away. A backgrounded
shell keeps this session's process alive after the turn ends, and the machine
this runs on has little spare memory.

So: background a command only if you will read it; kill it with \`KillShell\`
the moment you are done. If you start a long-lived server, you own stopping it
before the task is finished. Anything you can simply wait for should be an
ordinary foreground call — a command that merely takes a while does not need
backgrounding, and gets reported as still-running either way.`;
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
    ephemeral,
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

  /**
   * Endpoint + credential the CLI will run against. Resolved here, before the
   * stream opens, so a model whose provider has no key configured fails as a
   * plain 400 the composer can show instead of a mid-stream error block.
   */
  let sdkEnv: NodeJS.ProcessEnv;
  try {
    sdkEnv = buildProviderEnv(resolvedModel, process.env);
  } catch (err) {
    if (err instanceof MissingProviderCredentialError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  /**
   * Which harness serves this turn.
   *
   * For an existing conversation the STORED backend wins, unconditionally —
   * it was fixed when the conversation was created and the engine that owns
   * its session store cannot change under it. Whatever the client asked for is
   * ignored here, so a stale tab cannot drag a conversation onto the other
   * engine and silently lose its history.
   *
   * Only a brand-new conversation takes the client's choice.
   *
   * `CLAUDECHAT_OPENCODE=0` forces everything back onto the Agent SDK, so a
   * problem with the newer path is one env var away from being sidestepped.
   */
  const storedBackend = sessionId ? getConversationBackend(sessionId) : null;
  const requestedBackend = isValidBackend(body.backend)
    ? body.backend
    : defaultBackendForModel(resolvedModel);
  let backend: ChatBackend = storedBackend ?? requestedBackend;
  if (process.env.CLAUDECHAT_OPENCODE === '0') backend = 'sdk';

  // A Claude model cannot run on OpenCode (Anthropic blocked subscription
  // credentials in third-party harnesses). Refuse plainly rather than falling
  // back to the other engine, which would fork the conversation's history.
  if (!supportsBackend(resolvedModel, backend)) {
    return Response.json(
      {
        error:
          `${getModelInfo(resolvedModel).label} cannot run on ` +
          `${getBackendInfo(backend).label}. This conversation is pinned to ` +
          `that engine, so pick a different model or start a new conversation.`,
      },
      { status: 400 },
    );
  }

  const useOpencode = backend === 'opencode';

  /**
   * Thinking is always sent — `thinkingForModel` already translated it into
   * the shape this model's provider accepts. The effort ladder is the part
   * that doesn't carry over: DeepSeek spells it `reasoning_effort`, which the
   * CLI never emits, so sending Anthropic's `effort` would be a no-op at best.
   */
  const thinkingControls = supportsEffortLadder(resolvedModel)
    ? { thinking: sdkThinking, effort }
    : { thinking: sdkThinking };

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
      // Notebook text the model wrote before the conversation id was known
      // (brand-new conversation, pre-session-id). Flushed to the DB by
      // initConversation the moment the SDK emits the session id.
      let pendingNotebook: string | null = null;
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
       * True when the assistant message that closed the current turn was
       * FABRICATED by the CLI rather than produced by the model (model
       * `<synthetic>` — e.g. "No response requested." on resume). Such a turn
       * means "nothing happened yet", not "the turn is done", so its `result`
       * must not tear the input stream down at the normal 150 ms grace.
       * Reset in beginNextTurn.
       */
      let syntheticTurn = false;
      /**
       * True once the CLI has auto-compacted during the current turn.
       *
       * Compaction means the turn has not started answering yet — it has only
       * finished making room. But it gets there by making its OWN model call,
       * which sets `lastAssistantApiUsageTotal` and so convinces the synthetic
       * guard below that a real answer already happened. The guard is defeated
       * by the exact event it most needs to cover, and the turn is torn down
       * 150 ms later, before the real answer begins.
       *
       * That is the "conversation dies after an API error" bug: a turn big
       * enough to fail on a 529 is also big enough that the NEXT message
       * triggers auto-compaction, so every retry came back empty. Reset in
       * beginNextTurn.
       */
      let compactedThisTurn = false;
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
      /**
       * Total context footprint described by one `usage` payload, or 0 when it
       * carries no counts.
       *
       * Providers do not agree on WHERE this arrives. Anthropic fills in the
       * assistant message's `usage`. Z.AI (GLM) sends the assistant message
       * with `{input_tokens: 0, output_tokens: 0}` and only reports real counts
       * on the `message_delta` stream event and the final `result` — so reading
       * the assistant message alone leaves the meter pinned at zero for the
       * whole conversation. Every source is fed through this one function and
       * the largest reading for the turn wins.
       */
      const usageTotal = (usage: AnyRecord | null): number => {
        if (!usage) return 0;
        return (
          (Number(usage.input_tokens) || 0) +
          (Number(usage.output_tokens) || 0) +
          (Number(usage.cache_read_input_tokens) || 0) +
          (Number(usage.cache_creation_input_tokens) || 0)
        );
      };
      /** Publish a usage reading to the meter, ignoring empty/stale ones. */
      const reportUsage = (usage: AnyRecord | null): void => {
        const callTotal = usageTotal(usage);
        if (callTotal <= 0 || callTotal === lastAssistantApiUsageTotal) return;
        lastAssistantApiUsageTotal = callTotal;
        // Push the fresh reading immediately — the meter tracks the loop live
        // instead of jumping once at the end. The split rides along so
        // credit-billed models can price the next send: cache reads and
        // cache writes are both "already-seen context" for costing, and
        // differ from fresh input by an order of magnitude.
        send({
          type: 'token_budget',
          used: callTotal,
          total: 1_000_000,
          split: {
            input: Number(usage?.input_tokens) || 0,
            cached:
              (Number(usage?.cache_read_input_tokens) || 0) +
              (Number(usage?.cache_creation_input_tokens) || 0),
            output: Number(usage?.output_tokens) || 0,
          },
        });
      };

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

      /**
       * Persistence must never take the stream down. The case that actually
       * happens is a throwaway conversation the user discarded while its turn
       * was still running: the row is gone, every write hits a foreign-key
       * error, and there is — by definition — nothing worth saving. Log it and
       * let the turn finish.
       */
      const persistSafely = (what: string, write: () => void) => {
        try {
          write();
        } catch (err) {
          console.warn(
            `[chat] ${what} skipped:`,
            err instanceof Error ? err.message : err,
          );
        }
      };

      const persistAssistant = () => {
        if (!activeConversationId || isCompactOp) return;
        if (!turnLive) return;
        const conversationId = activeConversationId;
        persistSafely('assistant persist', () => {
          upsertMessage({
            id: currentTurn.assistantMessageId,
            conversationId,
            role: 'assistant',
            seq: currentAssistantSeq,
            createdAt: currentAssistantCreatedAt,
            blocks: [...blocks],
          });
          touchConversation(conversationId, Date.now());
        });
        lastPersistAt = Date.now();
      };

      const persistAssistantThrottled = () => {
        if (Date.now() - lastPersistAt < PERSIST_INTERVAL_MS) return;
        persistAssistant();
      };

      const persistTurnUserMessage = () => {
        if (!activeConversationId || isCompactOp) return;
        const conversationId = activeConversationId;
        const userBlocks: ContentBlock[] = [];
        if (currentTurn.userImages && currentTurn.userImages.length > 0) {
          userBlocks.push(...currentTurn.userImages);
        }
        if (currentTurn.prompt) {
          userBlocks.push({ type: 'text', id: newBlockId(), text: currentTurn.prompt });
        }
        persistSafely('turn persist', () => {
          const userSeq = nextMessageSeq(conversationId);
          upsertMessage({
            id: currentTurn.userMessageId,
            conversationId,
            role: 'user',
            seq: userSeq,
            createdAt: Date.now(),
            blocks: userBlocks,
          });
          currentAssistantSeq = userSeq + 1;
          currentAssistantCreatedAt = Date.now();
          upsertMessage({
            id: currentTurn.assistantMessageId,
            conversationId,
            role: 'assistant',
            seq: currentAssistantSeq,
            createdAt: currentAssistantCreatedAt,
            blocks: [],
          });
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
      /**
       * Background tasks (async subagents / backgrounded shells) started this
       * stream and not yet settled, keyed by the SDK's `task_id`. Non-empty
       * means work is still in flight AFTER the parent turn's `result`, so the
       * input must stay open — see BACKGROUND_TASK_GRACE_MS.
       */
      const liveTasks = new Set<string>();
      /**
       * Backgrounded shells, tracked apart from `liveTasks` because they earn a
       * much shorter hold — see BACKGROUND_SHELL_GRACE_MS.
       */
      const liveShellTasks = new Set<string>();
      /**
       * Tool calls that passed `run_in_background: true`.
       *
       * `task_started` carries no background flag, so this is how a genuinely
       * backgrounded shell is told apart from one the SDK merely registered
       * after ~2 seconds so it could offer Ctrl+B. Without it every slow
       * command looks backgrounded.
       */
      const backgroundedToolUses = new Set<string>();

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

      /**
       * Arm the post-turn input close. Always RE-arms with the latest delay so
       * a turn that finished under a long grace (see the synthetic-turn case in
       * the `result` handler) can be brought back to the normal short grace as
       * soon as real output lands — otherwise one long grace would keep the
       * stream open for its full duration no matter what happened afterwards.
       */
      const scheduleIdleClose = (delayMs: number = POST_TURN_GRACE_MS) => {
        if (inputClosed) return;
        if (inputQueue.length > 0) return;
        // A subagent outliving the turn keeps the stream open: its tool calls
        // are permissioned through `canUseTool` on this stream, so closing here
        // would abort the agent's very next tool use. A backgrounded shell has
        // no such dependency and only gets a brief hold.
        const floor =
          liveTasks.size > 0
            ? AGENT_TASK_GRACE_MS
            : liveShellTasks.size > 0
              ? BACKGROUND_SHELL_GRACE_MS
              : 0;
        const delay = Math.max(delayMs, floor);
        if (closingTimer) {
          clearTimeout(closingTimer);
          closingTimer = null;
        }
        closingTimer = setTimeout(() => {
          closingTimer = null;
          if (inputClosed) return;
          if (inputQueue.length > 0) return;
          inputClosed = true;
          wakeInput();
        }, delay);
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
        syntheticTurn = false;
        compactedThisTurn = false;
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
        // A turn is starting, so the stream is needed again. Without this a
        // timer armed while the model was idle keeps counting and can close the
        // input mid-turn, which costs that turn its permission channel.
        if (closingTimer) {
          clearTimeout(closingTimer);
          closingTimer = null;
        }
        needsNewTurn = false;
      };

      const initConversation = (sid: string) => {
        if (activeConversationId) return;
        const now = Date.now();
        ensureConversation(sid, cwd, now, {
          ephemeral: ephemeral === true,
          backend: 'sdk',
        });
        activeConversationId = sid;

        // Flush any notebook note the model wrote before we knew the id — the
        // conversation row now exists, so the FK is satisfied.
        if (pendingNotebook != null) {
          writeNotebook(sid, pendingNotebook, now);
          pendingNotebook = null;
        }

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

        // ===== OpenCode backend =====
        // Branch before anything below, all of which is specific to the Claude
        // Code CLI: the transcript repair and `resume` both address that CLI's
        // on-disk session format, which OpenCode neither writes nor reads — it
        // owns its sessions and serves them over its own API.
        if (useOpencode) {
          // Release the SDK-side inject registration first. The OpenCode stream
          // registers its own queue under the same id, and leaving both live
          // would let a racing inject land in the SDK input queue that nothing
          // on this path ever consumes.
          unregister();
          const envBlock = isRemote
            ? await buildSshEnvBlock(cwd)
            : buildLocalEnvBlock(cwd);
          const corePrefix = readSystemPrompt();
          const baseSystem = [
            corePrefix,
            envBlock,
            buildRenderingBlock(),
            // OpenCode namespaces MCP tools as `<server>_<tool>`.
            buildMcpBlock({
              cwd,
              isRemote,
              toolPrefix: 'mcp_',
              attached: listServersForWorkspace(cwd),
            }),
            // OpenCode does not route tool calls through canUseTool, so the
            // one-level rule is guidance there rather than enforcement.
            buildAgentsBlock(false, describeLiveAgents(sessionId ?? null, Date.now())),
          ]
            .filter(Boolean)
            .join('\n\n');
          const notebookBlock = buildNotebookBlock(
            sessionId ? readNotebook(sessionId) : '',
          );
          send({ type: 'stream_ready', streamId });
          await runOpencodeStream({
            model: resolvedModel,
            cwd,
            directory: sdkCwd,
            isRemote,
            sessionId: sessionId ?? null,
            system: `${baseSystem}\n\n${notebookBlock}`,
            prompt,
            userMessageId,
            assistantMessageId,
            images,
            userImages: buildUserImageBlocks(images),
            ephemeral: ephemeral === true,
            streamId,
            send,
            signal: req.signal,
            env: process.env,
          });
          return;
        }

        // Heal a transcript poisoned by a provider-executed tool before the CLI
        // replays it. A provider that mints server-tool ids its own validator
        // rejects makes the conversation permanently unresumable, and the bad
        // blocks are already on disk by the time we see the failure — so the
        // repair has to happen here, ahead of `resume`, not after an error.
        if (sessionId) {
          try {
            const repair = repairTranscript(sdkTranscriptPath(sdkCwd, sessionId));
            if (repair.repaired) {
              console.warn(
                `[chat] repaired transcript ${sessionId}: dropped ${repair.removed} ` +
                  `record(s) for provider tool(s) ${repair.toolNames.join(', ')}`,
              );
            }
          } catch {
            // Never block a turn on the repair — a resume that still fails is
            // strictly better than one that cannot start.
          }
        }
        const envBlock = isRemote
          ? await buildSshEnvBlock(cwd)
          : buildLocalEnvBlock(cwd);
        const remoteMcp = isRemote
          ? await createRemoteMcpServer({ workspaceCwd: cwd })
          : null;
        // Per-conversation notebook — available in every workspace. The live
        // conversation id isn't known until the SDK emits the session id, so a
        // note the model writes before then is held in `pendingNotebook` and
        // flushed to the DB by initConversation. This keeps the tool ALWAYS
        // available — no "not available yet" error on the first turn.
        const notebookConversationId = (): string | null =>
          activeConversationId ?? sessionId ?? null;
        const notebookMcp = createNotebookMcpServer({
          read: () => {
            const id = notebookConversationId();
            return id ? readNotebook(id) : (pendingNotebook ?? '');
          },
          write: (content: string) => {
            const id = notebookConversationId();
            if (id) {
              writeNotebook(id, content, Date.now());
              pendingNotebook = null;
            } else {
              pendingNotebook = content;
            }
          },
        });
        const mcpServers: Record<string, ReturnType<typeof createNotebookMcpServer>> = {
          notebook: notebookMcp,
        };
        if (remoteMcp) mcpServers.remote = remoteMcp;
        // Two-way reach. `remoteToolsToBlock` below strips every built-in
        // filesystem tool in an SSH workspace so the model cannot silently act
        // on the wrong machine — which also leaves it unable to touch the box
        // cloudchat runs on. This hands that back under unmistakable names.
        // Only in remote workspaces: locally the built-ins already do this job
        // and a second set would just be two ways to say the same thing.
        if (isRemote) mcpServers.local = createLocalMcpServer();
        // Own the provider's injected vision tool instead of letting it
        // server-execute a broken one. Registering a client `analyze_image`
        // makes Z.AI route the call to us; we do the real work via a
        // multimodal model. Only added for providers that inject it, so
        // Anthropic/DeepSeek conversations are unaffected.
        if (providerInjectsVision(resolvedModel)) {
          mcpServers.vision = createVisionMcpServer({
            model: resolvedModel,
            workspaceCwd: cwd,
          }) as ReturnType<typeof createNotebookMcpServer>;
        }
        // Third-party MCP servers configured for THIS FOLDER. Each is a lazy
        // pass-through proxy — a dead entry fails its own handshake (surfaced
        // by the init check below), never the turn. The `mcp` management
        // server lets the model wire new servers in mid-conversation; they
        // attach on the next message, when this map is rebuilt.
        for (const entry of listServersForWorkspace(cwd)) {
          mcpServers[entry.name] = proxyMcpServerFactory(entry)();
        }
        mcpServers.mcp = createMcpManagerServer({ workspaceCwd: cwd, isRemote });
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
        // Existing notes for a resumed conversation (empty for a brand-new
        // one). Read here so they're part of the system prompt from turn one;
        // notes the model writes mid-conversation surface on the next message.
        const notebookNotes = sessionId ? readNotebook(sessionId) : '';
        const notebookBlock = buildNotebookBlock(notebookNotes);
        const baseSystem = [
          corePrefix,
          envBlock,
          buildRenderingBlock(),
          // The CLI namespaces MCP tools as `mcp__<server>__<tool>`.
          buildMcpBlock({
            cwd,
            isRemote,
            toolPrefix: 'mcp__mcp__',
            attached: listServersForWorkspace(cwd),
          }),
          buildAgentsBlock(true, describeLiveAgents(sessionId ?? null, Date.now())),
        ]
          .filter(Boolean)
          .join('\n\n');
        // Stamped here so the init check can report how long the CLI spawn plus
        // MCP handshake actually took when a server misses the window.
        const spawnStartedAt = Date.now();
        // How many times the CLI announced itself for this one turn, and
        // whether the user has already been told tooling is degraded.
        let initCount = 0;
        let mcpWarningSent = false;
        const queryInstance = query({
          prompt: promptInput,
          options: {
            cwd: sdkCwd,
            model: getWireModelId(resolvedModel),
            ...thinkingControls,
            includePartialMessages: true,
            tools: { type: 'preset', preset: 'claude_code' },
            ...(isRemote ? { disallowedTools: remoteToolsToBlock } : {}),
            mcpServers,
            ...(mode && mode !== 'default' ? { permissionMode: mode } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            systemPrompt: `${baseSystem}\n\n${notebookBlock}`,
            env: sdkEnv,
            pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH || 'claude',
            hooks: NO_NESTED_SUBAGENT_HOOKS,
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

          // ===== Background task lifecycle (async subagents) =====
          // The Agent/Task tool can run a subagent asynchronously: the parent
          // turn's `result` arrives while the agent is still working. Track
          // the open tasks so the input stream is not closed underneath them
          // (a closed stream kills `canUseTool` and every tool the agent tries
          // fails with "AbortError: Stream closed"), and surface progress so
          // the run is visible instead of looking hung.
          if (message.type === 'system') {
            const sub = (message as AnyRecord & { subtype?: string }).subtype;
            const taskId = asString((message as AnyRecord).task_id);
            // ===== Did our MCP servers actually connect? =====
            // Everything in `mcpServers` runs in THIS process and has to
            // complete a handshake with the CLI at boot. When that handshake
            // fails the CLI starts anyway, just without those tools — so the
            // model does not get a broken tool, it gets no tool at all
            // ("No such tool available: mcp__notebook__notebook"), and
            // ToolSearch cannot find it either because an unregistered server
            // is not deferred, it is absent. Nothing else reports this: the
            // turn looks completely normal right up until the model reaches
            // for a tool that silently is not there.
            //
            // On a local workspace that costs the notebook. On an SSH one it
            // costs EVERY file tool — the built-ins are disallowed precisely
            // because `remote` is supposed to replace them — so the agent is
            // left unable to touch the filesystem with no explanation.
            //
            // `init` is the only message that carries this, and it arrives
            // before any turn does work, so a degraded session is caught at
            // the top rather than diagnosed from a confusing failure later.
            if (sub === 'init') {
              initCount += 1;
              const declared = Object.keys(mcpServers);
              const reported = Array.isArray((message as AnyRecord).mcp_servers)
                ? ((message as AnyRecord).mcp_servers as unknown[])
                    .map(asRecord)
                    .filter((r): r is AnyRecord => r != null)
                : [];
              const statusOf = new Map(
                reported.map((r) => [asString(r.name) ?? '', asString(r.status) ?? '']),
              );
              // `status` is the CLI's mcpClient discriminated union tag:
              // 'connected' | 'failed' | 'pending' | 'needs-auth'. Only the
              // states that are definitively terminal are reported, plus a
              // server missing from the list entirely (which is what the
              // observed notebook failure looked like — not registered at
              // all). 'pending' is deliberately NOT treated as broken: it can
              // still resolve, and a false warning on every message would be
              // worse than the bug this catches.
              const broken = declared.filter((name) => {
                const status = statusOf.get(name);
                return (
                  status === undefined ||
                  status === 'failed' ||
                  status === 'needs-auth'
                );
              });
              if (broken.length > 0) {
                const detail = broken
                  .map((n) => `${n} (${statusOf.get(n) ?? 'not registered'})`)
                  .join(', ');
                // Everything needed to diagnose the next occurrence, in one
                // line. This failure has resisted reproduction — a 40 s
                // event-loop stall, resume, concurrent queries and unreachable
                // remote connectors all keep the servers registered — so the
                // useful move is to capture the state at the moment it happens
                // rather than infer it afterwards. `init` number matters most:
                // every recorded failure logged TWO inits for one turn, which
                // healthy turns never do, so the CLI is being re-initialised.
                console.error(
                  '[chat] MCP servers missing from session init ' +
                    JSON.stringify({
                      init: initCount,
                      msSinceSpawn: Date.now() - spawnStartedAt,
                      missing: broken,
                      declared,
                      reported: reported.map(
                        (r) => `${asString(r.name)}=${asString(r.status)}`,
                      ),
                      toolCount: Array.isArray((message as AnyRecord).tools)
                        ? ((message as AnyRecord).tools as unknown[]).length
                        : null,
                      session: asString((message as AnyRecord).session_id)?.slice(0, 8),
                      resumed: sessionId != null,
                      cwd,
                      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
                    }),
                );
                // Reported once per turn even when the CLI re-inits, because
                // the second identical error block was itself the bug the user
                // saw — the same warning twice for one message.
                if (!mcpWarningSent) {
                  mcpWarningSent = true;
                  const warning =
                    `Tooling degraded: the ${detail} tool server(s) did not finish ` +
                    'connecting before the session started, so those tools are ' +
                    'missing for this message. They cannot be recovered mid-session — ' +
                    'send the message again to get them back.';
                  // Persisted as well as sent: the model is about to answer a
                  // whole turn without tools it normally has, and that turn is
                  // only intelligible later if the reason is stored beside it.
                  if (turnLive) {
                    blocks.push({ type: 'error', id: newBlockId(), text: warning });
                  }
                  send({ type: 'error', error: warning });
                }
              }
              continue;
            }
            if (sub === 'task_started' && taskId) {
              const rec = message as AnyRecord;
              const subagentType = asString(rec.subagent_type) ?? null;
              const taskType = asString(rec.task_type) ?? null;
              const taskToolUseId = asString(rec.tool_use_id) ?? null;

              // Ambient housekeeping work. The SDK's own type documents that
              // consumers must keep these out of the transcript.
              if (rec.skip_transcript === true) continue;

              const isAgent = subagentType != null || AGENT_TASK_TYPES.has(taskType ?? '');
              // The SDK registers a task for ANY shell still running after ~2
              // seconds, just so it can offer Ctrl+B — that command is still a
              // blocking part of the turn. Only a call that actually asked for
              // `run_in_background` outlives it.
              const isBackgrounded =
                !isAgent && taskToolUseId != null && backgroundedToolUses.has(taskToolUseId);

              // Which set it lands in decides how long the stream is pinned
              // after the turn ends. A foreground shell pins nothing: the turn
              // it belongs to is still open, and holding the stream for it kept
              // a CLI process resident long after the work was done.
              if (isAgent) liveTasks.add(taskId);
              else if (isBackgrounded) liveShellTasks.add(taskId);

              // The registry is what a LATER turn reads to learn what is still
              // running, so only real subagents belong in it.
              if (subagentType) {
                agentStarted(notebookConversationId(), {
                  id: taskId,
                  description: asString(rec.description) ?? '',
                  agentType: subagentType,
                  startedAt: Date.now(),
                });
              }
              send({
                type: 'task_started',
                taskId,
                description: asString(rec.description) ?? '',
                subagentType,
                taskType,
                toolUseId: taskToolUseId,
                isBackgrounded: isAgent || isBackgrounded,
              });
              continue;
            }
            if (sub === 'task_updated' && taskId) {
              // The only authoritative "this went to the background" signal on
              // the stream — it is how Ctrl+B and the SDK's own auto-background
              // are reported, and it arrives nowhere else.
              const patch = asRecord((message as AnyRecord).patch) ?? {};
              const nowBackgrounded = patch.is_backgrounded === true;
              if (nowBackgrounded && !liveTasks.has(taskId)) liveShellTasks.add(taskId);
              send({
                type: 'task_updated',
                taskId,
                isBackgrounded: nowBackgrounded,
                status: asString(patch.status) ?? null,
              });
              continue;
            }
            if (sub === 'task_progress' && taskId) {
              const rec = message as AnyRecord;
              send({
                type: 'task_progress',
                taskId,
                description: asString(rec.description) ?? '',
                lastToolName: asString(rec.last_tool_name) ?? null,
              });
              continue;
            }
            if (sub === 'task_notification' && taskId) {
              liveTasks.delete(taskId);
              liveShellTasks.delete(taskId);
              agentFinished(notebookConversationId(), taskId);
              const rec = message as AnyRecord;
              send({
                type: 'task_finished',
                taskId,
                status: asString(rec.status) ?? 'completed',
                summary: asString(rec.summary) ?? '',
              });
              // Last task done and the model is already idle. Step off the long
              // agent grace, but not all the way to 150 ms: this notification is
              // what wakes the model to read the result, and that turn needs the
              // stream for its own tool calls. See TASK_WAKE_GRACE_MS.
              if (liveTasks.size === 0 && liveShellTasks.size === 0 && needsNewTurn) {
                scheduleIdleClose(TASK_WAKE_GRACE_MS);
              }
              continue;
            }
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
            // The turn is now mid-flight, not finished — see `compactedThisTurn`.
            // Only for a real turn: on a manual `/compact` the compaction IS
            // the whole job, so its `result` genuinely ends the stream and
            // holding it open would leave the composer stuck for the full
            // grace after the user's own explicit command had finished.
            if (!isCompactOp) compactedThisTurn = true;
            // The compaction's own model call is not this turn's answer, so it
            // must not be what makes `lastAssistantApiUsageTotal` non-null.
            // Clearing it restores the invariant that guard depends on: "no
            // real model call has produced an answer on this stream yet". The
            // meter does not lose anything — the boundary below sends
            // `postTokens`, which is the more accurate reading anyway.
            lastAssistantApiUsageTotal = null;
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
              const conversationId = activeConversationId;
              persistSafely('compact boundary persist', () => {
                const seq = nextMessageSeq(conversationId);
                upsertMessage({
                  id: sysMessageId,
                  conversationId,
                  role: 'system',
                  seq,
                  createdAt: Date.now(),
                  blocks: [compactBlock],
                });
                touchConversation(conversationId, Date.now());
              });
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

          // ===== Subagent content belongs to the subagent, not this turn =====
          // A Task/Agent subagent runs its own conversation and streams it
          // through this same channel, tagged with `parent_tool_use_id`. Every
          // branch below mutates THIS turn's block list and its index→type map,
          // so letting a subagent through corrupts the parent transcript three
          // ways at once:
          //
          //   1. Its text/thinking/tool_use blocks are appended to the parent's
          //      message. A single Explore agent added 131 tool cards to one
          //      answer here — the message visibly never stopped growing.
          //   2. Its `message_start`/`message_stop` call `closeOpenInlineBlocks`
          //      and clear `openBlocks` on the PARENT. That drops the index
          //      mapping for the parent's still-open text block, so the parent's
          //      real `text_stop` never fires and the message sits blinking,
          //      waiting for tokens that already arrived.
          //   3. Its `result` would run the end-of-turn path — closing and
          //      persisting the parent's turn while the parent is mid-sentence.
          //
          // Background agents already have their own surface: the `task_*`
          // events handled above, which drive the "N agents running" strip.
          // Usage is filtered separately at each `reportUsage` call site,
          // because a subagent's context size must not move this meter either.
          if ((message as AnyRecord).parent_tool_use_id != null) continue;

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
              // Token counts for providers that leave the assistant message's
              // usage zeroed and only report here (see `reportUsage`). This is
              // what keeps the meter live mid-turn on GLM. Subagents run in
              // their own context, so their usage must not clobber this one.
              if ((message as AnyRecord).parent_tool_use_id == null) {
                reportUsage(asRecord(event.usage));
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
            if ((message as AnyRecord).parent_tool_use_id == null) {
              reportUsage(asRecord(inner?.usage));
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
            // A `<synthetic>` model means the CLI fabricated this message
            // instead of calling the API (classically "No response requested."
            // right after a resume). It carries no streaming events at all, so
            // everything below — and the longer grace in the `result` handler —
            // exists because this message is the ONLY place its content
            // appears.
            // Assignment, not |=: this tracks the MOST RECENT assistant
            // message, so a synthetic placeholder followed by a real answer
            // correctly leaves the turn marked non-synthetic.
            syntheticTurn = asString(inner?.model) === '<synthetic>';
            const content = inner?.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                const r = asRecord(part);
                if (!r) continue;
                // Text normally arrives as content_block deltas and is already
                // in `blocks` by now, so this is a no-op for a streamed turn.
                // It is NOT a no-op for a message the CLI synthesised (no
                // stream events ever fire): without adopting the text here the
                // turn would be persisted with zero blocks and the user would
                // sit staring at silence — which is exactly what "it never
                // gives a message back" looked like.
                if (r.type === 'text') {
                  const finalText = asString(r.text) ?? '';
                  const alreadyShown =
                    !finalText.trim() ||
                    blocks.some(
                      (b) => b.type === 'text' && b.text.trim() === finalText.trim(),
                    );
                  if (!alreadyShown) {
                    closeOpenInlineBlocks();
                    blocks.push({
                      type: 'text',
                      id: newBlockId(),
                      text: finalText,
                      streaming: false,
                    });
                    send({ type: 'text_start' });
                    send({ type: 'text_delta', text: finalText });
                    send({ type: 'text_stop' });
                    persistAssistantThrottled();
                  }
                  continue;
                }
                // Provider-executed ("server") tools. Some Anthropic-compatible
                // providers attach their own server-side tools on top of the
                // ones this app registers — Z.AI injects a vision MCP whose
                // `analyze_image` never appears in the CLI's tool list, so it
                // cannot be filtered with `disallowedTools`. The model can and
                // does call them, and the call runs entirely provider-side.
                //
                // Surface them as a normal tool block so the run is visible
                // instead of silently vanishing. Crucially they are surfaced
                // under a synthetic local id: a provider-issued server-tool id
                // must never be replayed back to the provider. Z.AI mints ids
                // in OpenAI form (`call_…`) while its own validator demands
                // `^srvtoolu_`, so echoing one back 400s every later request
                // and permanently wedges the conversation.
                if (r.type === 'server_tool_use') {
                  const toolName = asString(r.name) ?? 'tool';
                  closeOpenInlineBlocks();
                  blocks.push({
                    type: 'tool_use',
                    id: newBlockId(),
                    // Local, non-replayable id — deliberately not r.id.
                    toolUseId: `server:${newBlockId()}`,
                    name: `${toolName} (provider)`,
                    input: asRecord(r.input) ?? {},
                    streaming: false,
                  });
                  persistAssistantThrottled();
                  continue;
                }
                if (r.type === 'tool_use') {
                  const id = asString(r.id) ?? '';
                  if (!id) continue;
                  const toolName = asString(r.name) ?? 'tool';
                  // Recorded before the task event arrives: `task_started`
                  // carries no background flag, so the call's own input is the
                  // only place the intent is stated.
                  if (asRecord(r.input)?.run_in_background === true) {
                    backgroundedToolUses.add(id);
                  }
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
            // NB: do NOT feed `result.usage` into the meter. Providers disagree
            // on what it means — Anthropic reports the LAST API call's
            // footprint, but Z.AI (GLM) reports the SUM of every call in the
            // function-call loop. On a 5-call loop of ~23k each that sum is
            // ~116k, and on a long agentic loop it balloons to the "1.4M"
            // craziness. The live per-call reading already came through the
            // `message_delta` path (and the assistant-message path for
            // Anthropic); the result total is redundant at best and wrong on
            // GLM, so it is intentionally ignored here.
            //
            // Final consistency send: the LAST model API call's footprint.
            // Never the SDK's `modelUsage` — that also sums every iteration of
            // the loop and would blow the meter past the real context size.
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
            // Read before beginNextTurn — promoting a turn resets the flag.
            // `lastAssistantApiUsageTotal == null` means no real model call has
            // happened on this stream yet, which is what separates "the CLI
            // hasn't started working" from "a finished turn that merely ended
            // on a synthetic message".
            // A compaction counts the same way a synthetic message does: it
            // says "still getting ready", not "here is your answer". It is
            // checked INSTEAD of `syntheticTurn` (not AND-ed) because the CLI
            // does not always follow a compaction with a synthetic placeholder
            // — sometimes `result` simply arrives with nothing in the turn.
            const closedTurnWasSynthetic =
              (syntheticTurn || compactedThisTurn) &&
              lastAssistantApiUsageTotal == null;
            if (pendingTurnMetas.length > 0 && !isCompactOp) {
              beginNextTurn();
            }
            // A synthetic turn is the CLI saying "nothing to do yet", not a
            // finished answer — closing the input now (150 ms) would kill the
            // run before the real turn starts. Wait much longer in that case;
            // any later `result` re-arms this at the normal grace.
            scheduleIdleClose(
              closedTurnWasSynthetic
                ? SYNTHETIC_TURN_GRACE_MS
                : POST_TURN_GRACE_MS,
            );
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
          // A turn that ends with nothing at all is never a valid answer — it
          // renders as an empty bubble and reads as the app hanging. Say what
          // happened instead of persisting silence.
          if (blocks.length === 0) {
            // Name the actual cause when we know it. A turn that compacted and
            // then produced nothing consumed the message into the compaction —
            // telling the user "the CLI is rebuilding its cache" would send
            // them off diagnosing the wrong thing entirely.
            const emptyMsg = compactedThisTurn
              ? 'The conversation was compacted to free up context, and the ' +
                'turn ended before answering — your message was consumed by ' +
                'the compaction rather than replied to. Send it again; the ' +
                'compaction has already happened, so this time it will be ' +
                'answered against the freed-up context.'
              : 'The session ended this turn without producing a response. ' +
                'For a very large conversation the CLI can need several minutes ' +
                'to rebuild its prompt cache before it starts answering. Send the ' +
                'message again — if it keeps happening, start a new conversation ' +
                'in this folder.';
            blocks.push({ type: 'error', id: newBlockId(), text: emptyMsg });
            send({ type: 'error', error: emptyMsg });
          }
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
        // Subagents live inside the CLI process this stream owns, so once it
        // is gone nothing can still be running. Without this a task whose
        // completion event never arrived would be reported to every later turn
        // as live forever.
        clearConversation(activeConversationId ?? sessionId ?? null);
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
