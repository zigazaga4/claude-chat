/**
 * Auto-compaction: when a long function-calling loop passes a token threshold
 * the user chose, stop the loop, compact the conversation, and tell the model
 * to continue — without the user touching anything.
 *
 * Three steps, each in the place that can do it reliably:
 *
 *   1. SERVER stops the loop. The Claude Code CLI fires a `PostToolBatch` hook
 *      once every tool call of an iteration has resolved and before the next
 *      model request. Returning `{ continue: false }` from it ends the turn
 *      right there — verified against the real CLI: `terminal_reason:
 *      "hook_stopped"`, no interrupt marker, the finished tool results kept in
 *      the transcript, and no model call wasted. That boundary is the whole
 *      reason this is a hook and not an abort: aborting from outside can land
 *      mid-tool, and it races the old CLI process still writing the transcript
 *      that the compaction is about to resume.
 *   2. SERVER reports it. The stream ends with an `auto_compact` event, sent
 *      only after the CLI has exited, so the session is free to be resumed.
 *   3. CLIENT chains the rest: a normal `/compact` run, then a normal
 *      "Continue." send. Those are the same two paths the Compact button and
 *      the message box already use, so there is no second compaction or send
 *      implementation to keep in step.
 *
 * Pure and free of Node and SDK imports, so the picker in the browser offers
 * exactly the values the server will accept.
 */

/** Below this a compaction would fire again almost as soon as it finished. */
export const AUTO_COMPACT_MIN_TOKENS = 100_000;

/** Granularity of the values the picker offers. */
export const AUTO_COMPACT_STEP_TOKENS = 50_000;

/**
 * Highest share of the model's window the threshold may sit at. Past it the
 * CLI's own emergency compaction (which arms near the top of the window) would
 * get there first, making the setting a no-op that merely looks configured.
 */
export const AUTO_COMPACT_MAX_WINDOW_SHARE = 0.9;

/** What the model is told once the compaction is done. */
export const AUTO_COMPACT_CONTINUE_PROMPT = 'Continue.';

/** Largest threshold the server accepts for a model with this context window. */
export function autoCompactLimit(contextWindow: number): number {
  return Math.floor(contextWindow * AUTO_COMPACT_MAX_WINDOW_SHARE);
}

/**
 * The thresholds worth offering for a model: every step from the minimum up to
 * the limit. Empty when the window is too small for compaction to be useful.
 */
export function autoCompactChoices(contextWindow: number): number[] {
  const limit = autoCompactLimit(contextWindow);
  const out: number[] = [];
  for (let t = AUTO_COMPACT_MIN_TOKENS; t <= limit; t += AUTO_COMPACT_STEP_TOKENS) {
    out.push(t);
  }
  return out;
}

/**
 * Coerce an untrusted threshold (request body, persisted state) into a usable
 * one, or 0 meaning "off". Anything that cannot be honoured is off rather than
 * clamped: a silently different number than the one the user picked would be
 * worse than the setting visibly not applying.
 */
export function normalizeAutoCompactAt(raw: unknown, contextWindow: number): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  const t = Math.floor(n);
  if (t < AUTO_COMPACT_MIN_TOKENS || t > autoCompactLimit(contextWindow)) return 0;
  return t;
}

/**
 * How full the context may still be after a compaction for auto-compact to stay
 * armed on the run that follows it, as a share of the threshold.
 *
 * Compaction rewrites the history into a summary, so how small it gets depends
 * on the summary, not on the threshold. If it lands close under the threshold
 * the next halt comes after almost no progress and every cycle pays for a
 * compaction to buy a few tool calls. Past this share the continuation runs
 * with auto-compact off instead — the CLI's own emergency compaction is still
 * there — and the divider showing the before/after sizes tells the user why.
 */
export const AUTO_COMPACT_REARM_SHARE = 0.75;

/** What one `runStream` call amounted to — enough to decide what comes next. */
export type StreamOutcome = {
  /** False when the request was refused before a stream opened. */
  ran: boolean;
  /** The user (or a network failure) cut the stream short. */
  aborted: boolean;
  /** A `compact_boundary` was seen, i.e. the conversation really was compacted. */
  compacted: boolean;
  /** Context size right after that compaction, when the CLI reported it. */
  postTokens?: number;
};

/** The options of `runStream` that the chain needs to set. */
export type ChainRunOptions = {
  prompt: string;
  instanceId: string;
  compact?: boolean;
  autoTriggered?: boolean;
  suppressAutoCompact?: boolean;
};

export type AutoCompactChainResult =
  | { status: 'continued' }
  | { status: 'stopped'; reason: 'not-run' | 'aborted' | 'no-boundary' };

/**
 * Steps 2 and 3 of the flow described at the top of this file: compact, then
 * send "Continue.". `run` is the same stream runner the Compact button and the
 * message box use.
 *
 * It stops, without sending "Continue.", whenever the compaction did not
 * demonstrably happen. Telling the model to continue on top of a failed
 * compaction would just halt again after the next tool batch and repeat, each
 * round paying for a compaction that never lands.
 */
export async function chainAutoCompact(
  run: (opts: ChainRunOptions) => Promise<StreamOutcome>,
  instanceId: string,
  limit: number,
): Promise<AutoCompactChainResult> {
  const compacted = await run({
    prompt: '/compact',
    instanceId,
    compact: true,
    autoTriggered: true,
  });
  if (!compacted.ran) return { status: 'stopped', reason: 'not-run' };
  if (compacted.aborted) return { status: 'stopped', reason: 'aborted' };
  if (!compacted.compacted) return { status: 'stopped', reason: 'no-boundary' };

  const tooFull =
    compacted.postTokens != null &&
    compacted.postTokens > limit * AUTO_COMPACT_REARM_SHARE;
  await run({
    prompt: AUTO_COMPACT_CONTINUE_PROMPT,
    instanceId,
    suppressAutoCompact: tooFull,
  });
  return { status: 'continued' };
}

/** The subset of a `PostToolBatch` hook input this hook reads. */
type BatchHookInput = {
  hook_event_name?: string;
  /** Set when the batch belongs to a subagent rather than the main thread. */
  agent_id?: string;
};

export type AutoCompactHookOptions = {
  /** Current threshold, read on every batch so it can change mid-stream. 0 = off. */
  limit: () => number;
  /** Context size after the most recent model call, or null before any. */
  used: () => number | null;
  /**
   * True while something would be lost by ending the stream — background
   * agents, which live inside the CLI process and die with it.
   */
  busy: () => boolean;
  /** Called once when the hook decides to halt the loop. */
  onTrip: (used: number, limit: number) => void;
};

/**
 * `PostToolBatch` hook that halts the main thread's loop once the context has
 * reached the threshold. Subagent batches are left alone — their context is
 * their own and ending the stream would take the parent's work with it.
 */
export function buildAutoCompactHook(opts: AutoCompactHookOptions) {
  return async (input: BatchHookInput) => {
    if (input.hook_event_name !== 'PostToolBatch' || input.agent_id) {
      return { continue: true };
    }
    const limit = opts.limit();
    const used = opts.used();
    if (!limit || used == null || used < limit || opts.busy()) {
      return { continue: true };
    }
    opts.onTrip(used, limit);
    return {
      continue: false,
      stopReason: `Context reached ${used} tokens (limit ${limit}); compacting before continuing.`,
    };
  };
}
