/**
 * Provider routing for the spawned Claude Code CLI.
 *
 * Every model this app exposes is served over the same Messages API wire
 * format, so switching provider is purely a matter of which endpoint the CLI
 * dials and which credential it presents. Both are environment variables the
 * CLI reads at startup, which makes the spawn env the single seam — no request
 * shape, transport, or SDK call site changes between providers.
 *
 * This module is the one place that knows how to build that env. Keep it
 * server-only: it reads credentials out of the process environment.
 */

import {
  getContextWindow,
  getProvider,
  type ModelId,
  type ModelProvider,
} from '@/lib/models';

/**
 * How a provider expects its credential to be presented.
 *
 * The CLI turns each variable into a different header — `ANTHROPIC_API_KEY`
 * becomes `x-api-key`, `ANTHROPIC_AUTH_TOKEN` becomes `Authorization: Bearer`.
 * Providers accept one or the other, and sending both is not a harmless
 * belt-and-braces move: two auth headers on one request is an auth failure.
 * So each config names its variable and the other is always cleared.
 */
type AuthStyle = 'api-key' | 'bearer';

const AUTH_VAR: Record<AuthStyle, string> = {
  'api-key': 'ANTHROPIC_API_KEY',
  bearer: 'ANTHROPIC_AUTH_TOKEN',
};

type ProviderConfig = {
  /** Anthropic-compatible base. Note this is not always the OpenAI-compatible root. */
  baseUrl: string;
  /**
   * Env var that overrides `baseUrl` when set. Mirrors the OpenCode side's
   * `baseUrlVar` so a single variable redirects both backends at once — used
   * where one provider has regional mirrors of the same API (Qwen's intl/CN
   * Token Plan hosts, for instance).
   */
  baseUrlVar?: string;
  /** Env var this app reads the credential from. */
  credentialVar: string;
  authStyle: AuthStyle;
  /**
   * Overrides for the model tiers the CLI reaches for on its own (titles and
   * other cheap background calls). Left empty when the provider resolves
   * unknown names itself.
   */
  tierAliases?: Record<string, string>;
};

const PROVIDERS: Record<
  Exclude<ModelProvider, 'anthropic'>,
  ProviderConfig
> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    credentialVar: 'DEEPSEEK_API_KEY',
    authStyle: 'api-key',
    tierAliases: {
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    },
  },
  openrouter: {
    // OpenRouter's Anthropic-compatible surface hangs off /api, NOT the
    // /api/v1 root used by its OpenAI-compatible endpoint.
    baseUrl: 'https://openrouter.ai/api',
    credentialVar: 'OPENROUTER_API_KEY',
    authStyle: 'bearer',
    tierAliases: {
      // Background calls go to a cheap, fast, widely-hosted model rather than
      // burning the frontier model on conversation titles.
      ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-4.7-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-4.7-flash',
    },
  },
  kimi: {
    // Kimi Code subscription. Moonshot serves this endpoint in Anthropic's
    // wire format, which is why the CLI can reach it at all — the pay-as-you-go
    // API at platform.kimi.ai is a separate billing account whose keys are
    // rejected here.
    baseUrl: 'https://api.kimi.com/coding/v1',
    credentialVar: 'KIMI_API_KEY',
    authStyle: 'bearer',
    tierAliases: {
      ANTHROPIC_SMALL_FAST_MODEL: 'k3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'k3',
    },
  },
  zai: {
    // First-party GLM, billed against the user's coding-plan subscription
    // instead of per-token through a marketplace.
    baseUrl: 'https://api.z.ai/api/anthropic',
    credentialVar: 'ZAI_API_KEY',
    authStyle: 'bearer',
    tierAliases: {
      // glm-4.7 is Z.AI's own recommended cheap tier for background work.
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    },
  },
  qwen: {
    // Alibaba Model Studio Token Plan (credits subscription). Like Z.AI, the
    // base stops BEFORE /v1 — the CLI appends /v1/messages itself. The intl
    // host is the default; the CN mirror
    // (token-plan.cn-beijing.maas.aliyuncs.com) is one QWEN_BASE_URL away.
    // Credentials are the dedicated plan keys (`sk-sp-…`), NOT the
    // pay-as-you-go DASHSCOPE_API_KEY.
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
    baseUrlVar: 'QWEN_BASE_URL',
    credentialVar: 'QWEN_API_KEY',
    authStyle: 'bearer',
    tierAliases: {
      // qwen3.6-flash is on the Token Plan and is its cheapest text tier.
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.6-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-flash',
    },
  },
};

/**
 * Thrown when the selected model's provider has no credential configured.
 * Carries the variable name so the caller can tell the user exactly what to
 * set rather than surfacing a bare 401 from the upstream endpoint.
 */
export class MissingProviderCredentialError extends Error {
  constructor(
    readonly provider: ModelProvider,
    readonly envVar: string,
  ) {
    super(
      `No API key for ${provider}. Set ${envVar} in .env.local (or the ` +
        `server environment) and restart the server to use this model.`,
    );
    this.name = 'MissingProviderCredentialError';
  }
}

type Env = NodeJS.ProcessEnv;

/**
 * Variables that would silently re-route the request somewhere other than the
 * configured base URL. Cleared for every non-Anthropic spawn so an operator's
 * inherited shell config can't override the provider the user picked.
 */
const ROUTING_OVERRIDES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * Build the environment for a CLI spawn that will serve `model`.
 *
 * Anthropic models pass `base` through untouched, preserving any proxy or
 * gateway the operator configured. Every other provider gets its endpoint,
 * credential, and tier aliases written in, the unused auth variable cleared,
 * and the Bedrock/Vertex switches removed.
 *
 * @throws {MissingProviderCredentialError} when the provider needs a key that
 *   is not present in `base`.
 */
export function buildProviderEnv(model: ModelId, base: Env): Env {
  const provider = getProvider(model);
  if (provider === 'anthropic') return { ...base };

  const config = PROVIDERS[provider];
  const apiKey = base[config.credentialVar]?.trim();
  if (!apiKey) {
    throw new MissingProviderCredentialError(provider, config.credentialVar);
  }

  const env: Env = { ...base };
  for (const key of ROUTING_OVERRIDES) delete env[key];

  // Exactly one auth variable survives; the other is cleared so the CLI can't
  // send two credentials on the same request.
  const authVar = AUTH_VAR[config.authStyle];
  const unusedAuthVar =
    authVar === AUTH_VAR['api-key'] ? AUTH_VAR.bearer : AUTH_VAR['api-key'];
  delete env[unusedAuthVar];
  env[authVar] = apiKey;

  env.ANTHROPIC_BASE_URL =
    (config.baseUrlVar ? base[config.baseUrlVar]?.trim() : undefined) ||
    config.baseUrl;
  for (const [key, value] of Object.entries(config.tierAliases ?? {})) {
    env[key] = value;
  }

  // The CLI hard-codes a 200,000-token context window for any model id its
  // own registry doesn't list — and that registry only contains Anthropic
  // models. Every provider here serves 1M-class models the CLI has never
  // heard of, so without this the CLI auto-compacts at a fraction of 200k
  // while the app's meter (which reads OUR registry) honestly reports a
  // fifth of the window. CLAUDE_CODE_MAX_CONTEXT_TOKENS is the CLI's own
  // override for exactly this case, honored only for ids that don't start
  // with "claude-" — which is every model that reaches this branch, and
  // none that don't.
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(getContextWindow(model));
  return env;
}
