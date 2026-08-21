/**
 * Provider routing for the OpenCode backend.
 *
 * The Agent SDK path (see `src/server/providers.ts`) reaches every non-Anthropic
 * model through that provider's *Anthropic-compatible* shim, because the CLI it
 * spawns only speaks the Messages API. OpenCode has no such constraint: it
 * drives providers through the Vercel AI SDK, so each model is reached on its
 * own native endpoint with no translation layer in between. That is the
 * substantive win of this backend.
 *
 * OpenCode ships the models.dev registry, which already describes all three of
 * our providers — endpoints, model ids, context limits, capability flags, and
 * pricing. Rather than restate any of that, this module supplies only what the
 * registry cannot know: which credential to use, and which single provider is
 * allowed to serve a given turn. Verified against a live server (2026-08-01):
 *
 *   deepseek         https://api.deepseek.com            deepseek-v4-pro / -flash
 *   openrouter       https://openrouter.ai/api/v1        moonshotai/kimi-k3
 *   zai-coding-plan  https://api.z.ai/api/coding/paas/v4 glm-5.2
 *   alibaba-token-plan  https://token-plan.ap-southeast-1.maas.aliyuncs.com  qwen3.8-max (intl; CN mirror via QWEN_BASE_URL — NOT yet live-verified)
 *
 * The Z.AI mapping is the one that matters most. `zai-coding-plan` bills
 * against the coding subscription; the plain `zai` entry points at
 * `paas/v4`, the pay-as-you-go endpoint, and selecting it would silently start
 * charging per token. The mapping below is what keeps the subscription route
 * the only one this app can reach.
 *
 * Keep server-only: reads credentials from the process environment.
 */

import type { Config } from '@opencode-ai/sdk';
import {
  MODELS,
  getContextWindow,
  getModelInfo,
  getProvider,
  getWireModelId,
  type ModelId,
  type ModelProvider,
} from '@/lib/models';
import { MissingProviderCredentialError } from '@/server/providers';

/** Providers this backend serves. Anthropic stays on the Agent SDK. */
export type OpencodeProvider = Exclude<ModelProvider, 'anthropic'>;

type ProviderSpec = {
  /**
   * Provider id as models.dev names it. Declaring this id in config *merges*
   * with the registry entry rather than replacing it, so the curated endpoint
   * and model metadata survive and we only add the credential.
   */
  registryId: string;
  /** Env var carrying the credential. */
  credentialVar: string;
  /** Optional env var overriding the registry's endpoint. */
  baseUrlVar: string;
};

const SPECS: Record<OpencodeProvider, ProviderSpec> = {
  deepseek: {
    registryId: 'deepseek',
    credentialVar: 'DEEPSEEK_API_KEY',
    baseUrlVar: 'DEEPSEEK_BASE_URL',
  },
  openrouter: {
    registryId: 'openrouter',
    credentialVar: 'OPENROUTER_API_KEY',
    baseUrlVar: 'OPENROUTER_BASE_URL',
  },
  zai: {
    // NOT the registry's `zai` entry — see the file header. This one is the
    // subscription endpoint; `zai` is pay-as-you-go.
    registryId: 'zai-coding-plan',
    credentialVar: 'ZAI_API_KEY',
    baseUrlVar: 'ZAI_BASE_URL',
  },
  kimi: {
    // Likewise the subscription route: `kimi-for-coding` is the Kimi Code
    // endpoint, distinct from the registry's `moonshotai` entry which bills the
    // separate pay-as-you-go developer account.
    registryId: 'kimi-for-coding',
    credentialVar: 'KIMI_API_KEY',
    baseUrlVar: 'KIMI_BASE_URL',
  },
  qwen: {
    // `alibaba-token-plan` is the registry's Token Plan endpoint (intl,
    // credits subscription). The plan keys (`sk-sp-…`) are NOT the
    // pay-as-you-go DASHSCOPE_API_KEY the plain `alibaba` entry wants. CN
    // mirror: point QWEN_BASE_URL at token-plan.cn-beijing.maas.aliyuncs.com.
    registryId: 'alibaba-token-plan',
    credentialVar: 'QWEN_API_KEY',
    baseUrlVar: 'QWEN_BASE_URL',
  },
};

/** Whether a model is served by OpenCode rather than the Agent SDK. */
export function isOpencodeProvider(
  provider: ModelProvider,
): provider is OpencodeProvider {
  return provider !== 'anthropic';
}

/** models.dev id for one of our providers. */
export function registryProviderId(provider: OpencodeProvider): string {
  return SPECS[provider].registryId;
}

/** `moonshotai/kimi-k3` → `MOONSHOTAI_KIMI_K3`, for env-var naming. */
function envSuffix(model: ModelId): string {
  return model.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Model id to put on the wire.
 *
 * `getWireModelId` carries OpenRouter's `:nitro` routing suffix, which pins the
 * request to the highest-throughput host instead of letting OpenRouter pick on
 * price — these models are served by many hosts of varying quality and the
 * cheapest is often a degraded quantisation. The suffix is not a catalog entry,
 * so `extraModelsFor` declares it below; without that, OpenCode would reject it
 * as an unknown model.
 *
 * A single model can be redirected without a code change, e.g.
 * `CLAUDECHAT_OPENCODE_MODEL_GLM_5_2=glm-5.2-highspeed[1m]`.
 */
export function opencodeModelId(model: ModelId, env: NodeJS.ProcessEnv): string {
  const override = env[`CLAUDECHAT_OPENCODE_MODEL_${envSuffix(model)}`]?.trim();
  return override || getWireModelId(model);
}

/**
 * Credential for a provider.
 *
 * @throws {MissingProviderCredentialError} naming the variable to set, so the
 *   user gets an actionable message instead of a bare 401 from upstream.
 */
export function credentialFor(
  provider: OpencodeProvider,
  env: NodeJS.ProcessEnv,
): string {
  const { credentialVar } = SPECS[provider];
  const key = env[credentialVar]?.trim();
  if (!key) throw new MissingProviderCredentialError(provider, credentialVar);
  return key;
}

/**
 * Models this app exposes that the registry does not list under their wire id.
 *
 * Only routing-suffixed ids need this today. The metadata is copied from the
 * base model so capability flags (tool calling, reasoning, context) stay
 * accurate — OpenCode gates behaviour on them, and a model it believes cannot
 * call tools is handed no tools at all.
 */
function extraModelsFor(
  provider: OpencodeProvider,
  env: NodeJS.ProcessEnv,
): NonNullable<NonNullable<Config['provider']>[string]['models']> {
  const models: NonNullable<
    NonNullable<Config['provider']>[string]['models']
  > = {};
  for (const info of MODELS) {
    if (getProvider(info.id) !== provider) continue;
    const wire = opencodeModelId(info.id, env);
    // Only routing-suffixed ids need synthesising. A plain id — including one
    // that differs from ours, like `kimi-k3-code` → `k3` — is already in the
    // catalog with pricing and limits we should not be guessing at, and
    // declaring it here would override that curated metadata with estimates.
    if (!wire.includes(':')) continue;
    models[wire] = {
      id: wire,
      name: info.label,
      tool_call: true,
      reasoning: true,
      attachment: provider !== 'deepseek',
      // Same source as the UI gauge, so the engine and the meter cannot
      // disagree about how much room is left. Output ceiling matches what
      // these models actually publish — under-declaring it would cap
      // generation short of what the provider allows.
      limit: { context: getContextWindow(info.id), output: 131_072 },
    };
  }
  return models;
}

/**
 * Build the `provider` block for the one provider serving this turn.
 *
 * Only that provider is declared, and `buildEnabledProviders` pins OpenCode to
 * it. Leaving the others live would let OpenCode fall back to a provider the
 * user did not pick — it happily auto-detects any recognised key in the
 * environment, and this process holds all three.
 */
export function buildProviderConfig(
  provider: OpencodeProvider,
  env: NodeJS.ProcessEnv,
): NonNullable<Config['provider']> {
  const spec = SPECS[provider];
  const baseUrlOverride = env[spec.baseUrlVar]?.trim();
  const extraModels = extraModelsFor(provider, env);

  return {
    [spec.registryId]: {
      options: {
        apiKey: credentialFor(provider, env),
        ...(baseUrlOverride ? { baseURL: baseUrlOverride } : {}),
      },
      ...(Object.keys(extraModels).length > 0 ? { models: extraModels } : {}),
    },
  };
}

/** Lock OpenCode to the single provider serving this turn. */
export function buildEnabledProviders(provider: OpencodeProvider): string[] {
  return [SPECS[provider].registryId];
}

/** `provider/model` as OpenCode names it — the format `Config.model` wants. */
export function qualifiedModel(model: ModelId, env: NodeJS.ProcessEnv): string {
  const provider = getProvider(model);
  if (!isOpencodeProvider(provider)) {
    throw new Error(`${model} is not served by the OpenCode backend`);
  }
  return `${SPECS[provider].registryId}/${opencodeModelId(model, env)}`;
}

/** The `{ providerID, modelID }` pair `session.prompt` expects. */
export function promptModel(
  model: ModelId,
  env: NodeJS.ProcessEnv,
): { providerID: string; modelID: string } {
  const provider = getProvider(model);
  if (!isOpencodeProvider(provider)) {
    throw new Error(`${model} is not served by the OpenCode backend`);
  }
  return {
    providerID: SPECS[provider].registryId,
    modelID: opencodeModelId(model, env),
  };
}

/**
 * Cheap model for OpenCode's own background work (session titles, summaries).
 *
 * Stays on the turn's provider so no second credential is needed, preferring a
 * cheaper tier where the registry has one. Falls back to the turn's own model
 * rather than guessing at an id — a slightly pricier title beats a hard failure
 * on every turn.
 */
export function smallModelFor(model: ModelId, env: NodeJS.ProcessEnv): string {
  const cheaper: Partial<Record<OpencodeProvider, ModelId>> = {
    deepseek: 'deepseek-v4-flash',
  };
  const provider = getProvider(model);
  if (!isOpencodeProvider(provider)) return qualifiedModel(model, env);
  const pick = cheaper[provider];
  return qualifiedModel(pick ?? model, env);
}

/** Human-readable provider label, for error messages. */
export function providerLabel(model: ModelId): string {
  return getModelInfo(model).label;
}
