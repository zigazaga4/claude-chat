/**
 * When the SDK input stream may be closed, and when it must not be.
 *
 * Closing the input is how a finished turn lets the CLI exit. It is only safe
 * when nothing can start another turn afterwards, because every SDK hook and
 * every in-process MCP tool (`notebook`, the SSH `remote` file tools, …) is a
 * request the CLI sends back over that same channel. Once it is closed those
 * requests go unanswered and the CLI abandons the call with its generic
 * cancellation text — "The user doesn't want to take this action right now" —
 * which the model reads as the user refusing. Nobody refused anything.
 *
 * What can start a turn with no user message is background work. A backgrounded
 * shell, a Monitor, an async subagent: each reports back with a
 * `task_notification` that wakes the model, and the woken turn calls tools.
 * Measured against the real CLI (2.1.312): close the input 150 ms after a
 * `result` with a background task running, and the CLI does NOT exit — it waits
 * for the task however long that takes (a 3600 s task was still being waited
 * on after 75 s), then runs the woken turn, and the first tool of that turn
 * comes back cancelled whenever a `PreToolUse` hook is registered. Closing the
 * input therefore never freed the process; it only broke the turn that would
 * have used it.
 *
 * So the rule is the opposite of "close early": while background work is live
 * the input stays open, and the CLI is only ever stopped by ending it outright.
 */

/**
 * How long to wait, with nothing happening but background work, before giving
 * up on it and stopping the CLI. This is not a grace for the work to finish —
 * it is the bound on a task that never does (a dev server, a watcher). Past it
 * the CLI is killed with its children, which is what already happened to them
 * whenever the stream ended; the difference is that it is now a decision made
 * on purpose instead of a half-closed process that wakes into a broken turn.
 *
 * Generous because the cost of waiting is small — the CLI would be resident
 * anyway for as long as the task lives — and the cost of giving up early is a
 * lost build. The longest background command seen finishing on its own in the
 * recorded transcripts ran 98 minutes; a subagent ran 34.
 */
export const BACKGROUND_WORK_HOLD_MS = 2 * 60 * 60_000;

/**
 * The hold actually applied: the default, or `CLOUDCHAT_BACKGROUND_HOLD_MS`
 * when that is a positive number. The override exists so the give-up path —
 * which otherwise needs two real hours to reach — can be exercised.
 */
export function backgroundHoldMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const override = Number(env.CLOUDCHAT_BACKGROUND_HOLD_MS);
  return Number.isFinite(override) && override > 0 ? override : BACKGROUND_WORK_HOLD_MS;
}

/** "2 hours", "45 minutes", "30 seconds" — for telling the user how long it waited. */
export function describeDuration(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const hours = ms / 3_600_000;
  if (hours >= 1 && Number.isInteger(hours)) return unit(hours, 'hour');
  const minutes = ms / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) return unit(minutes, 'minute');
  return unit(Math.max(1, Math.round(ms / 1000)), 'second');
}

/** What to do when the idle-close timer fires. */
export type IdleExpiryAction =
  /** A turn is running — leave it alone; its `result` will re-arm the timer. */
  | 'defer'
  /** Background work is still live — stop the CLI, do not half-close it. */
  | 'terminate'
  /** Genuinely idle — close the input and let the CLI exit by itself. */
  | 'close';

export function idleExpiryAction(state: {
  turnInFlight: boolean;
  backgroundWork: number;
}): IdleExpiryAction {
  // A timer armed after one turn can outlive the start of the next (the
  // wake-up grace is minutes long). Closing under a turn that is mid-flight is
  // exactly the failure this module exists to prevent.
  if (state.turnInFlight) return 'defer';
  return state.backgroundWork > 0 ? 'terminate' : 'close';
}

/** The minimum idle-close delay while `backgroundWork` tasks are live. */
export function holdFloorMs(
  backgroundWork: number,
  env?: Record<string, string | undefined>,
): number {
  return backgroundWork > 0 ? backgroundHoldMs(env) : 0;
}

/**
 * Task ids → task types from a `background_tasks_changed` message.
 *
 * That message is a LEVEL signal: it carries the whole live set every time the
 * membership changes, so the caller replaces its set rather than pairing
 * start/finish edges — a missed edge cannot leave a stale entry behind.
 * `ambient` tasks are housekeeping, not activity, and must not hold the stream.
 */
export function liveBackgroundTasks(message: { tasks?: unknown }): Map<string, string> {
  const live = new Map<string, string>();
  if (!Array.isArray(message.tasks)) return live;
  for (const t of message.tasks) {
    if (!t || typeof t !== 'object') continue;
    const { task_id, task_type, ambient } = t as {
      task_id?: unknown;
      task_type?: unknown;
      ambient?: unknown;
    };
    if (typeof task_id !== 'string' || ambient === true) continue;
    live.set(task_id, typeof task_type === 'string' ? task_type : 'unknown');
  }
  return live;
}

/**
 * Is this SDK message the main conversation starting or doing work?
 *
 * Decides when an idle-close timer must stand down: the CLI began a turn on its
 * own (a woken one, or the first events of a queued message) and the input has
 * to be there for it. Subagent traffic does not count — it shares the channel
 * but is not the main turn, and background tasks are accounted for separately.
 * Task lifecycle and status messages do not count either; they arrive around a
 * turn without being one. `init` does: the CLI re-announces itself at the start
 * of a woken turn, before the model has said anything.
 */
export function startsMainThreadWork(message: {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
}): boolean {
  if (message.parent_tool_use_id != null) return false;
  switch (message.type) {
    case 'stream_event':
    case 'assistant':
    case 'user':
      return true;
    case 'system':
      return message.subtype === 'init';
    default:
      return false;
  }
}
