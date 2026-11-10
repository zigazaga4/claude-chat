/**
 * Letting the assistant choose the model and reasoning level of the agents it
 * launches, on the OpenCode backend.
 *
 * The Agent SDK path (`src/lib/subagentChoice.ts`) does this with the Agent
 * tool's own `model` and `effort` parameters. OpenCode's `task` tool has
 * neither — its parameters are description, prompt, subagent_type, task_id —
 * and an agent's model comes from the agent definition. So the choice is
 * offered the way OpenCode expresses it: as `subagent_type`. Each allowed
 * (model, reasoning level) pairing is a general-purpose agent defined in the
 * server config with that model and level pinned, and the assistant picks one
 * by name. Verified live: a subagent launched through the real `task` tool
 * ran with the `variant` its agent definition pinned.
 *
 * What is different from the Claude path, and why:
 *
 *   - Claude models are not an option. They cannot run on OpenCode at all (see
 *     `supportsBackend`). The choice is among the models this app runs on the
 *     conversation's own provider — a stream is pinned to one provider, so
 *     that is also all the server has a credential for.
 *   - Reasoning levels are the model's own. OpenCode calls them "variants" and
 *     they differ per model (`low/high/max`, `low/medium/xhigh`, none at all),
 *     so there is no fixed ladder to hard-code — and the catalog they come from
 *     refreshes on its own: DeepSeek Pro reported `high, max` and a few minutes
 *     later `low, high, max` during development. The levels are therefore
 *     discovered from OpenCode itself (see `discoverVariants` in server.ts).
 *   - The ceiling is the same one — nothing above `xhigh` — applied as: a model's
 *     levels above it are simply not offered. A model with adjustable
 *     reasoning is never offered at its *default* level either, because the
 *     default is whatever the provider picks (for Kimi K3 that is max).
 *   - The built-in `general` agent is switched off. It inherits the parent's
 *     model and level, so leaving it would be a way round every pairing.
 *     `explore` (read-only search) stays; it inherits likewise.
 *
 * Pure: takes the discovered levels as data, so it is testable without a server.
 */

import type { Config } from '@opencode-ai/sdk';
import {
  EFFORT_ORDER,
  MODELS,
  getProvider,
  type ModelId,
  type ModelInfo,
} from '@/lib/models';
import { supportsBackend } from '@/lib/backends';
import { SUBAGENT_EFFORT_CEILING, isWithinSubagentEffortCeiling } from '@/lib/subagentChoice';
import {
  opencodeModelId,
  qualifiedModel,
  type OpencodeProvider,
  type VariantDefs,
} from './providers';

/** Reasoning-level names OpenCode reports for each model, keyed by wire model id. */
export type VariantMap = Record<string, string[]>;

/** What one probe of a provider's catalog yields (see `readVariants`). */
export type VariantProbe = {
  /** Level names per wire model id, as the roster needs them. */
  levels: VariantMap;
  /** Level definitions borrowed for synthesised ids that came up empty. */
  inherited: VariantDefs;
};

/**
 * Read the reasoning levels of a provider's models out of the catalog OpenCode
 * reports (`models` is the `models` map of that provider's `config.providers()`
 * entry).
 *
 * A model this app synthesises (a `:nitro` suffix, an OpenRouter preset) is not
 * in that catalog under its wire id, so OpenCode derives its levels from the id
 * alone — and for some ids that is nothing, although the plain slug the preset
 * routes to (`info.id`) is listed with a full set. Verified: `z-ai/glm-5.3-flash`
 * has low/high/max while `@preset/glm-5-3-flash-fp8` has none, whereas
 * `@preset/deepseek-v4-1-flash-fp8` comes out with its own low/medium/high.
 * Leaving the GLM preset empty would make a model that does take a reasoning
 * level look like one that does not, so an empty synthesised id borrows the
 * slug's definitions (same weights, same provider API, only routing differs)
 * and they are returned in `inherited` for the server config to declare.
 * An id OpenCode did derive levels for is left exactly as it found it.
 */
export function readVariants(
  models: Record<string, { variants?: Record<string, Record<string, unknown>> } | undefined> | undefined,
  provider: OpencodeProvider,
  env: NodeJS.ProcessEnv,
): VariantProbe {
  const levels: VariantMap = {};
  const inherited: VariantDefs = {};
  for (const info of MODELS) {
    if (getProvider(info.id) !== provider || !supportsBackend(info.id, 'opencode')) continue;
    const wire = opencodeModelId(info.id, env);
    let defs = models?.[wire]?.variants;
    if ((!defs || Object.keys(defs).length === 0) && wire !== info.id) {
      const base = models?.[info.id]?.variants;
      if (base && Object.keys(base).length > 0) {
        defs = base;
        inherited[wire] = base;
      }
    }
    levels[wire] = defs ? Object.keys(defs) : [];
  }
  return { levels, inherited };
}

export type RosterEntry = {
  /** The `subagent_type` the assistant passes to the task tool. */
  agent: string;
  model: ModelId;
  label: string;
  /** The reasoning level pinned on the agent, or null when the model has no adjustable one. */
  effort: string | null;
  lightweight: boolean;
  description: string;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Ladder position, so levels list low → high. Names off the ladder sort last. */
const rankOf = (level: string) => {
  const i = (EFFORT_ORDER as string[]).indexOf(level);
  return i === -1 ? EFFORT_ORDER.length : i;
};

function entryFor(info: ModelInfo, effort: string | null): RosterEntry {
  const tier = info.lightweight ? ' Faster and cheaper; suited to mechanical work.' : '';
  return {
    agent: `general-${slug(info.shortLabel)}${effort ? `-${effort}` : ''}`,
    model: info.id,
    label: info.label,
    effort,
    lightweight: info.lightweight === true,
    description:
      `General-purpose agent with all tools, running ${info.label}` +
      (effort ? ` at ${effort} reasoning.` : '.') +
      tier,
  };
}

/**
 * The pairings offered for a conversation whose model is `model`.
 *
 * `variants` is what OpenCode reported for this provider's models, or null when
 * discovery failed — in which case every model is offered once, at its default
 * level, rather than guessing at level names the server might not recognise (an
 * unknown variant is silently ignored by OpenCode, which would run the agent at
 * the provider default while the roster claimed otherwise).
 */
export function buildAgentRoster(
  model: ModelId,
  variants: VariantMap | null,
  env: NodeJS.ProcessEnv,
): RosterEntry[] {
  const provider = getProvider(model);
  const roster: RosterEntry[] = [];
  for (const info of MODELS) {
    if (getProvider(info.id) !== provider || !supportsBackend(info.id, 'opencode')) continue;
    const offered = variants?.[opencodeModelId(info.id, env)] ?? [];
    if (offered.length === 0) {
      roster.push(entryFor(info, null));
      continue;
    }
    const allowed = offered
      .filter(isWithinSubagentEffortCeiling)
      .sort((a, b) => rankOf(a) - rankOf(b));
    // Adjustable, but only above the ceiling: no pairing is both safe and
    // honest, and the default level is not one of them.
    for (const effort of allowed) roster.push(entryFor(info, effort));
  }
  return roster;
}

/**
 * Agent definitions for the server config: every pairing pinned, plus the
 * built-in `general` switched off. Empty when there is nothing to offer, so a
 * failed roster never strips the assistant of its only general agent.
 */
export function agentConfigFor(
  roster: RosterEntry[],
  env: NodeJS.ProcessEnv,
): NonNullable<Config['agent']> {
  if (roster.length === 0) return {};
  const agent: NonNullable<Config['agent']> = { general: { disable: true } };
  for (const e of roster) {
    agent[e.agent] = {
      mode: 'subagent',
      description: e.description,
      model: qualifiedModel(e.model, env),
      ...(e.effort ? { variant: e.effort } : {}),
    };
  }
  return agent;
}

/** What the assistant is told so it can pick well. Empty when there is no roster. */
export function buildAgentChoiceBlock(roster: RosterEntry[]): string {
  if (roster.length === 0) return '';

  const list = roster
    .map((e) => {
      const what = e.effort ? `${e.label}, ${e.effort} reasoning` : `${e.label}`;
      return `- \`${e.agent}\` — ${what}${e.lightweight ? ' (lighter, cheaper)' : ''}`;
    })
    .join('\n');

  const models = new Set(roster.map((e) => e.model));
  const adjustable = roster.some((e) => e.effort !== null);
  const guidance: string[] = [];
  if (models.size > 1) {
    guidance.push(
      roster.some((e) => e.lightweight)
        ? 'Use the lighter model for mechanical work that can be checked against itself — searches, listings, summaries, bulk repetitive edits — and the stronger one for hard reasoning, subtle bugs and design decisions.'
        : 'Use the model that fits the job.',
    );
  }
  if (adjustable) {
    guidance.push(
      `Within a model, raise the reasoning level for hard or high-stakes work and lower it for lookups. Levels run low to ${SUBAGENT_EFFORT_CEILING}; the highest, max, is not offered for agents. A model listed without a level has no adjustable reasoning here.`,
    );
  }
  guidance.push(
    'Choose the cheapest pairing that will reliably do the job — a cheap agent that fails costs the work twice — and agents launched together need not share one.',
  );

  return `# Choosing the model and reasoning level of each agent

The \`task\` tool starts an agent, and its \`subagent_type\` decides which model
runs it and how hard it reasons: the general-purpose agent is offered as
ready-made pairings, one per model and reasoning level. The user has asked you,
as a standing instruction, to pick one deliberately every time. The built-in
\`general\` agent is not available; \`explore\` (read-only search) is, and runs on
your own model at its default level.

${list}

${guidance.join(' ')}`;
}
