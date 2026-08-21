/**
 * Which harness runs a conversation.
 *
 * Two very different engines sit behind `/api/chat`, and the choice is made
 * once per conversation and then frozen. That is not a UI preference — it is a
 * correctness requirement. Each backend keeps its own session store under its
 * own id format (the Agent SDK writes Claude Code CLI transcripts keyed by a
 * UUID; OpenCode keeps `ses_…` sessions in its own storage), so a conversation
 * that changed backend mid-life would hand one engine an id the other minted.
 * The engine would not recognise it, silently start a fresh session, and the
 * conversation would continue with no memory of anything before the switch.
 *
 * Freezing the choice at creation makes that impossible by construction, which
 * is why there is no "switch backend" operation anywhere in the app.
 *
 * Keep this file dependency-free — it is imported by both the client picker
 * and the API route.
 */

import { getProvider, type ModelId } from './models';

export type ChatBackend = 'sdk' | 'opencode';

export const DEFAULT_BACKEND: ChatBackend = 'sdk';

export type BackendInfo = {
  id: ChatBackend;
  label: string;
  shortLabel: string;
  /** One line explaining the trade-off, shown in the picker. */
  description: string;
};

export const BACKENDS: BackendInfo[] = [
  {
    id: 'sdk',
    label: 'Claude Agent SDK',
    shortLabel: 'Agent SDK',
    description:
      'Runs the Claude Code CLI. The only way to use a Claude subscription, and it reaches other providers through their Anthropic-compatible endpoints.',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'OpenCode',
    description:
      'Open-source harness. Reaches DeepSeek, GLM, Kimi, and Qwen on their native endpoints — no Anthropic-compatible shim. Cannot run Claude models.',
  },
];

export function isValidBackend(value: unknown): value is ChatBackend {
  return value === 'sdk' || value === 'opencode';
}

export function getBackendInfo(id: ChatBackend): BackendInfo {
  return BACKENDS.find((b) => b.id === id) ?? BACKENDS[0];
}

/**
 * Whether a model can run on a backend.
 *
 * The Agent SDK serves everything: Claude natively, and every other provider
 * over its Anthropic-compatible endpoint. OpenCode cannot serve Claude —
 * Anthropic blocked subscription credentials in third-party harnesses in April
 * 2026, and routing Claude through OpenCode on a pay-per-token key is not what
 * anyone picking this app wants.
 */
export function supportsBackend(model: ModelId, backend: ChatBackend): boolean {
  if (backend === 'sdk') return true;
  return getProvider(model) !== 'anthropic';
}

/** Models runnable on `backend`, for filtering the model picker. */
export function modelsForBackend<T extends { id: ModelId }>(
  models: T[],
  backend: ChatBackend,
): T[] {
  return models.filter((m) => supportsBackend(m.id, backend));
}

/**
 * Backend to preselect for a model when the user has expressed no preference.
 *
 * Claude models can only run on the Agent SDK, so they pin to it. Everything
 * else defaults to OpenCode, where it reaches its provider directly instead of
 * through a translation layer.
 */
export function defaultBackendForModel(model: ModelId): ChatBackend {
  return getProvider(model) === 'anthropic' ? 'sdk' : 'opencode';
}
