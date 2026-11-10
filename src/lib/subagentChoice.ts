/**
 * Letting the assistant choose the model and thinking effort of the agents it
 * launches — within limits the app sets.
 *
 * The Claude CLI's Agent tool already takes `model` ("sonnet" | "opus" |
 * "haiku" | "fable") and `effort` ("low" … "max") — verified against the tool
 * schema in the installed binary, and live: a PreToolUse hook sees both on the
 * call, and a hook's `updatedInput` is what the subagent actually runs with
 * (a `max` rewritten to `xhigh` produced a subagent whose own hooks reported
 * `effort.level === "xhigh"`, on the model that was asked for).
 *
 * So nothing here adds a parameter. The CLI's own parameter descriptions tell
 * the model to leave them unset unless the user asks, which is the right
 * default for a general tool and the wrong one here — so the system prompt
 * (`buildSubagentChoiceBlock`) states the user's standing request, and a hook
 * (`buildSubagentChoiceHook`) enforces the two limits the user set:
 *
 *   - models: haiku, sonnet, opus. `fable` is refused.
 *   - effort: low … xhigh. `max` is lowered to `xhigh`.
 *
 * Pure rules live here, free of Node and SDK imports, so the tool card in the
 * browser can show the same effort the server will actually run.
 */

import { EFFORT_ORDER, type EffortLevel } from '@/lib/models';

/**
 * Tools that start a subagent. Both names are listed because the CLI has
 * shipped this tool under each, and matching only the current one would let a
 * version bump quietly bypass everything keyed on it.
 */
export const SUBAGENT_SPAWN_TOOLS = new Set(['Agent', 'Task']);

/**
 * The same set as a hook `matcher` (a regex over the tool name).
 *
 * Every `PreToolUse` hook that only concerns spawning must carry it. Without a
 * matcher the CLI asks the SDK to run the hook before EVERY tool call — Bash,
 * Read, each MCP tool — and each of those is a request over the control
 * channel. That makes the whole toolset depend on the stream being open, and a
 * stream that has closed answers none of them: the call is cancelled with the
 * "user doesn't want to take this action" text. Scoped, only an `Agent`/`Task`
 * call can be affected by that.
 */
export const SUBAGENT_SPAWN_MATCHER = [...SUBAGENT_SPAWN_TOOLS].join('|');

/**
 * The model tiers an agent may be launched on, with what each is for. One
 * list drives both the allow-check and the prompt, so they cannot drift.
 *
 * Tiers, not versions: the CLI resolves each alias to the newest model of that
 * family, so the prompt must not name a version that will go stale.
 */
const MODEL_TIERS = [
  {
    id: 'haiku',
    use:
      'fastest and cheapest. Mechanical work that can be checked against itself: ' +
      'grep-and-report searches, reading and listing many files, summarizing, ' +
      'bulk repetitive edits, running a command and reporting what it printed.',
  },
  {
    id: 'sonnet',
    use:
      'the workhorse. A well-specified change to implement, a code review, writing ' +
      'tests, a bug with a clear trail, research that needs some judgment.',
  },
  {
    id: 'opus',
    use:
      'the most capable and the most expensive. For work where a wrong answer ' +
      'costs more than the agent does: a subtle bug, an architecture or design ' +
      'decision, security-sensitive review, reasoning that spans many files.',
  },
] as const;

export type SubagentModelTier = (typeof MODEL_TIERS)[number]['id'];

export const SUBAGENT_MODEL_TIERS: readonly SubagentModelTier[] = MODEL_TIERS.map(
  (t) => t.id,
);

/** The highest effort an agent may run at. `max` is deliberately out of reach. */
export const SUBAGENT_EFFORT_CEILING: EffortLevel = 'xhigh';

const rank = (e: EffortLevel) => EFFORT_ORDER.indexOf(e);

function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_ORDER as string[]).includes(v);
}

/**
 * Whether a reasoning level is within what an agent may run at. Takes any
 * string because OpenCode models name their own levels (a model may offer
 * `low`, `high`, `max`, or even `xhigh` without `high`); a name this app has
 * never heard of is NOT within the ceiling, since nothing is known about it.
 */
export function isWithinSubagentEffortCeiling(level: string): boolean {
  return isEffortLevel(level) && rank(level) <= rank(SUBAGENT_EFFORT_CEILING);
}

/** Clamp an effort to the agent ceiling. Anything at or below it is untouched. */
export function capSubagentEffort(effort: EffortLevel): EffortLevel {
  return rank(effort) > rank(SUBAGENT_EFFORT_CEILING)
    ? SUBAGENT_EFFORT_CEILING
    : effort;
}

/** One step along the ladder, staying on it. */
function stepEffort(from: EffortLevel, direction: 'lower' | 'higher'): EffortLevel {
  const next = rank(from) + (direction === 'higher' ? 1 : -1);
  return EFFORT_ORDER[Math.min(Math.max(next, 0), EFFORT_ORDER.length - 1)];
}

export type SubagentSpawnDecision =
  | { action: 'allow' }
  /** Run the call with `input` instead; `notes` tell the model what changed. */
  | { action: 'rewrite'; input: Record<string, unknown>; notes: string[] }
  | { action: 'deny'; reason: string };

/**
 * Apply the app's limits to one Agent call.
 *
 * `turnEffort` is the effort the main turn runs at — what an agent inherits
 * when it is given none, and what the CLI's relative "lower"/"higher" values
 * step away from. Null when the turn sends no effort at all.
 */
export function resolveSubagentSpawn(
  input: Record<string, unknown>,
  turnEffort: EffortLevel | null,
): SubagentSpawnDecision {
  const model = input.model;
  if (
    typeof model === 'string' &&
    !(SUBAGENT_MODEL_TIERS as readonly string[]).includes(model)
  ) {
    return {
      action: 'deny',
      reason:
        `The "${model}" model is not available for agents in this app. ` +
        `Launch the agent again with model set to one of: ` +
        `${SUBAGENT_MODEL_TIERS.join(', ')}. If the user specifically asked ` +
        `for "${model}", tell them it is not permitted for agents.`,
    };
  }

  const requested = input.effort;
  const notes: string[] = [];
  let effective: EffortLevel | undefined;

  if (requested === 'lower' || requested === 'higher') {
    // Relative values step from the turn's effort, and "higher" from xhigh is
    // exactly how an agent would land on max by the back door.
    effective = capSubagentEffort(stepEffort(turnEffort ?? 'high', requested));
    notes.push(`Effort "${requested}" was resolved to "${effective}".`);
  } else if (isEffortLevel(requested)) {
    effective = capSubagentEffort(requested);
    if (effective !== requested) {
      notes.push(
        `Effort "${requested}" is not available for agents here; it runs at "${effective}".`,
      );
    }
  } else if (requested === undefined && turnEffort && rank(turnEffort) > rank(SUBAGENT_EFFORT_CEILING)) {
    // No effort given means "inherit mine". When mine is above the ceiling,
    // inheriting it would hand the agent the very level it is not allowed to
    // ask for, so the ceiling is applied to the default as well.
    effective = SUBAGENT_EFFORT_CEILING;
    notes.push(
      `Your own effort is "${turnEffort}"; this agent runs at "${effective}", the most an agent gets.`,
    );
  }

  if (effective === undefined || effective === requested) return { action: 'allow' };
  return { action: 'rewrite', input: { ...input, effort: effective }, notes };
}

/** What the model is told so it can pick well. */
export function buildSubagentChoiceBlock(): string {
  const tiers = MODEL_TIERS.map((t) => `- \`${t.id}\` — ${t.use}`).join('\n');
  return `# Choosing the model and effort of each agent

For every agent you launch you decide which Claude model runs it and how hard
it thinks, by setting the Agent tool's \`model\` and \`effort\` parameters. Those
parameters' own descriptions say to leave them unset unless the user asks; that
is advice for a general-purpose tool, and here the user has asked for the
opposite as a standing instruction: **set both on every Agent call**,
deliberately, to fit what that agent has to do.

\`model\` — one of ${SUBAGENT_MODEL_TIERS.map((t) => `\`${t}\``).join(', ')}:
${tiers}
Not available: \`fable\` (the call is refused). Leave \`model\` out only when you
want the agent on your own model.

\`effort\` — \`low\`, \`medium\`, \`high\` or \`xhigh\`; how much it reasons before
acting. \`max\` is not available to agents and is lowered to \`xhigh\`.
- \`low\` — lookups and retrieval, where the answer is found rather than worked out.
- \`medium\` — carrying out a brief that is already clear.
- \`high\` — the normal setting for real work.
- \`xhigh\` — hard problems, or where one subtle mistake would be expensive.

Choose the cheapest pairing that will reliably do the job, judged by the task
and not by your own settings. A cheap agent that fails costs the work twice, so
go up when the brief is ambiguous or the stakes are high. Agents launched
together need not share a pairing: a fan-out of searches can run \`haiku\` at
\`low\` while the one agent that reasons over what they found runs \`opus\` at
\`xhigh\`.`;
}

/**
 * PreToolUse hook that applies `resolveSubagentSpawn` to the main thread's
 * Agent calls. Calls from inside a subagent (`agent_id` set) are left alone:
 * those are already refused outright by the nesting guard.
 */
export function buildSubagentChoiceHook(turnEffort: EffortLevel | null) {
  return async (input: {
    tool_name?: string;
    agent_id?: string;
    tool_input?: unknown;
  }) => {
    if (input.agent_id || !SUBAGENT_SPAWN_TOOLS.has(input.tool_name ?? '')) {
      return { continue: true };
    }
    const toolInput =
      input.tool_input && typeof input.tool_input === 'object'
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const decision = resolveSubagentSpawn(toolInput, turnEffort);

    if (decision.action === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: decision.reason,
        },
      };
    }
    if (decision.action === 'rewrite') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: decision.input,
          additionalContext: decision.notes.join(' '),
        },
      };
    }
    return { continue: true };
  };
}
