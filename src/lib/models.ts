/**
 * Model registry shared between client and server. Lists the four models the
 * UI exposes, the always-on thinking config each one uses, and the effort
 * ("thinking power") options. Keep this file dependency-free so the API route
 * can import it without dragging in any React or browser-only code.
 *
 * Naming convention matches Anthropic's documented model IDs. Only CURRENT
 * Claude tiers are listed — Fable 5, Opus 5, Sonnet 5. Every superseded id
 * (Opus 4.8/4.7, Sonnet 4.6, Haiku 4.5) was dropped from the picker and lives
 * on only in `RETIRED_MODEL_IDS`, which re-points persisted conversations at
 * its successor. `claude-sonnet-5` is the floor; the Mythos-class flagship
 * `claude-fable-5` (released 2026-06-09) uses a single version number. The
 * `model` option is a free-form string the CLI resolves, so no SDK version
 * bump is required to use a new ID.
 *
 * Thinking model: adaptive thinking ("Claude decides when and how much to
 * think", Opus 4.6+) is ALWAYS ON for the models that support it — it isn't a
 * user toggle. Every model listed here supports it, so `extended` is currently
 * unused; it stays in the type because a non-adaptive model would need it. The
 * user-facing picker chooses the EFFORT level only, which the SDK docs describe
 * as the knob that "works with adaptive thinking to guide thinking depth."
 */

export type ModelId =
  | 'claude-fable-5'
  | 'claude-opus-5'
  | 'claude-sonnet-5'
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash'
  | 'moonshotai/kimi-k3'
  | 'kimi-k3-code'
  | 'glm-5.3'
  | 'qwen3.8-max';

/**
 * Which API a model is served by. Every provider here speaks the same Messages
 * API wire format, so the only things that change downstream are the endpoint
 * the CLI is pointed at, which env var carries the credential, and whether
 * Anthropic-specific knobs (adaptive thinking, the effort ladder) are accepted.
 * Absent means 'anthropic' — the historical default for this registry.
 */
export type ModelProvider =
  | 'anthropic'
  | 'deepseek'
  | 'openrouter'
  | 'zai'
  | 'kimi'
  | 'qwen';

/** Full SDK effort ladder. All models expose all of these in the picker. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Always-on thinking flavour for a model. */
export type ThinkingType = 'adaptive' | 'extended';

export type ModelInfo = {
  id: ModelId;
  label: string;
  shortLabel: string;
  /** Always-on thinking config flavour. Adaptive models keep adaptive on. */
  thinkingType: ThinkingType;
  /** Default effort when the user has no stored preference for this model. */
  defaultEffort: EffortLevel;
  /** Serving API. Omitted means 'anthropic'. */
  provider?: ModelProvider;
  /**
   * Model string actually sent to the API, when it differs from `id`. Used to
   * carry OpenRouter's routing suffixes (`:nitro` picks the highest-throughput
   * provider) without leaking them into the id the UI and stored preferences
   * key off. Omitted means the id is sent verbatim.
   */
  wireId?: string;
  /**
   * Usable context in tokens, when it differs from the app-wide 1M assumption.
   * Informational for now — the token gauge still reads the global constant.
   */
  contextWindow?: number;
};

/** The one effort ladder every model supports, low → max. */
export const EFFORT_ORDER: EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

export const MODELS: ModelInfo[] = [
  {
    // Anthropic's most capable widely released model (Mythos-class). Adaptive
    // thinking is always on and is the only thinking mode it supports.
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    shortLabel: 'Fable 5',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
  },
  {
    // Current Opus — for complex agentic coding and enterprise work. Same
    // $5/$25 per-MTok pricing, 1M context, and 128k max output as Opus 4.8;
    // adaptive thinking always on, effort defaults to high.
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    shortLabel: 'Opus 5',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
  },
  {
    // Current Sonnet — best balance of speed and intelligence. Adaptive
    // thinking is always on; the API defaults its effort to high.
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    shortLabel: 'Sonnet 5',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
  },
  {
    // DeepSeek's premium tier, served over their Anthropic-compatible
    // endpoint. Thinking is on by default and is not configurable per
    // request, so the effort ladder below is inert for this model — it stays
    // in the type only because the picker offers one ladder for every model.
    // 1M context, 384k max output.
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    shortLabel: 'DS V4 Pro',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'deepseek',
  },
  {
    // The efficiency tier — same 1M context, roughly a third of Pro's price.
    // Also the model DeepSeek falls back to for any unrecognised model name.
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    shortLabel: 'DS V4 Flash',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'deepseek',
  },
  {
    // Moonshot's frontier open-weight model (2.8T MoE), via OpenRouter. The
    // `:nitro` suffix pins routing to the highest-throughput provider rather
    // than letting OpenRouter pick on price — these are served by many hosts
    // of varying quality, and the cheapest is often a degraded quantisation.
    id: 'moonshotai/kimi-k3',
    wireId: 'moonshotai/kimi-k3:nitro',
    label: 'Kimi K3',
    shortLabel: 'Kimi K3',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'openrouter',
    contextWindow: 1_048_576,
  },
  {
    // The same Moonshot model, billed against a Kimi Code subscription instead
    // of per-token through OpenRouter. Moonshot serves it directly here, so
    // there is no marketplace routing and no provider roulette — but the key
    // is NOT interchangeable with a platform.kimi.ai developer key, which
    // bills a separate account. `k3` is the id Moonshot's coding endpoint
    // publishes; the marketplace spelling `moonshotai/kimi-k3` is rejected.
    //
    // Full 1M window, same as the model served through OpenRouter. `k3-256k`
    // is a SEPARATE, smaller variant on this endpoint — 262,144 was its number,
    // not this one's.
    id: 'kimi-k3-code',
    wireId: 'k3',
    label: 'Kimi K3 (Code Plan)',
    shortLabel: 'Kimi K3 Code',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'kimi',
    contextWindow: 1_048_576,
  },
  {
    // Current GLM, served directly by Z.AI on the user's coding-plan rather
    // than through a marketplace — no per-token markup and no provider
    // roulette.
    //
    // Older point releases are deliberately absent: the endpoint accepts
    // `glm-5.1` and `glm-5.2` but answers as glm-5.3 (verified — a request
    // naming 5.2 comes back with `"model":"glm-5.3"`), so listing them would
    // misreport what actually ran.
    //
    // Z.AI's docs recommend a bracketed `[1m]` suffix for the long-context
    // variant; those spellings are rejected with error 1211 (unknown model),
    // and the suffix is about NAMING rather than capability — the plain id is
    // already the 1M-context model. Confirmed against Z.AI's docs and
    // models.dev (the catalog OpenCode itself reads).
    id: 'glm-5.3',
    label: 'GLM 5.3',
    shortLabel: 'GLM 5.3',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'zai',
    contextWindow: 1_000_000,
  },
  {
    // Alibaba's flagship, billed against the Model Studio Token Plan (the
    // credits subscription) rather than per-token. Same weights as the
    // pay-as-you-go DASHSCOPE endpoint, but reached with a dedicated plan key
    // (`sk-sp-…`) — the PAYG DASHSCOPE_API_KEY is a different account and is
    // rejected here. Multimodal, 1M context, 131k max output.
    id: 'qwen3.8-max',
    label: 'Qwen 3.8 Max',
    shortLabel: 'Qwen 3.8',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'qwen',
    contextWindow: 1_048_576,
  },
];

export const DEFAULT_MODEL_ID: ModelId = 'claude-opus-5';

/**
 * Model used by the "auto effort" feature to classify a request and recommend
 * a thinking-effort level before the main turn starts. Sonnet 5 is fast and
 * cheap enough to gate every first message without adding noticeable latency.
 */
export const SUGGESTION_MODEL_ID: ModelId = 'claude-sonnet-5';

/**
 * Result of the auto-effort classifier: the recommended effort plus a short
 * human-readable justification the user sees before accepting or rejecting.
 */
export type EffortSuggestion = { effort: EffortLevel; reason: string };

export function getModelInfo(id: ModelId): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function isValidModelId(id: string): id is ModelId {
  return MODELS.some((m) => m.id === id);
}

/**
 * Retired ids and what they became.
 *
 * A tab's chosen model is persisted, so dropping an id without a mapping means
 * every instance sitting on it silently reverts to the default on next load —
 * a user who picked GLM would come back to Claude with no explanation. These
 * are also the exact ids Z.AI now answers with the successor for, so the
 * mapping matches what the endpoint already does.
 */
const RETIRED_MODEL_IDS: Record<string, ModelId> = {
  'glm-5.1': 'glm-5.3',
  'glm-5.2': 'glm-5.3',
  // Claude tiers below Sonnet 5 were dropped from the picker. Both map to
  // Sonnet 5 — the cheapest Claude still offered, and a strict upgrade on
  // either — so a conversation pinned to one keeps running on Claude rather
  // than silently landing on the default (Opus 5, far pricier per token).
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-haiku-4-5': 'claude-sonnet-5',
  // Legacy Opus, likewise dropped. These map UP to Opus 5 rather than across
  // to Sonnet: someone who chose Opus wanted the frontier tier, and Opus 5 is
  // the same price per token as 4.8 was.
  'claude-opus-4-8': 'claude-opus-5',
  'claude-opus-4-7': 'claude-opus-5',
};

/**
 * The live id for a possibly-stale one, or null if it is not recognised at all.
 * Callers restoring persisted state should use this rather than
 * `isValidModelId` alone.
 */
export function migrateModelId(id: string): ModelId | null {
  if (isValidModelId(id)) return id;
  return RETIRED_MODEL_IDS[id] ?? null;
}

/** Serving API for a model. Total function — unset means Anthropic. */
export function getProvider(id: ModelId): ModelProvider {
  return getModelInfo(id).provider ?? 'anthropic';
}

/**
 * Context window this app assumes for a model whose registry entry does not
 * state one. Most models here are 1M; the ones that differ say so.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Usable context for a model, in tokens — the denominator of the token gauge.
 *
 * Reading the real value matters most for the small-window models: GLM 5.2 has
 * 204,800, so measuring it against a flat 1M drew the meter at a fifth of its
 * true fullness and gave no warning before the window actually ran out.
 */
export function getContextWindow(id: ModelId): number {
  return getModelInfo(id).contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * The model string to put on the wire. Differs from the id only where routing
 * metadata has to ride along with it (see `ModelInfo.wireId`).
 */
export function getWireModelId(id: ModelId): string {
  return getModelInfo(id).wireId ?? id;
}

/**
 * Whether a model accepts Anthropic's effort ladder. DeepSeek exposes the same
 * idea under a different parameter name (`reasoning_effort`) which the CLI
 * never emits, so for those models the ladder is omitted rather than sent
 * under a name the endpoint does not read.
 */
export function supportsEffortLadder(id: ModelId): boolean {
  return getProvider(id) === 'anthropic';
}

export function isValidEffort(id: string): id is EffortLevel {
  return (EFFORT_ORDER as string[]).includes(id);
}

/**
 * Default effort for a model. Every model accepts the full ladder, so there's
 * no compatibility filtering to do — switching models only changes the
 * fallback default used when no preference is stored.
 */
export function getDefaultEffort(id: ModelId): EffortLevel {
  return getModelInfo(id).defaultEffort;
}
