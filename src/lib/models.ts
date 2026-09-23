/**
 * Model registry shared between client and server. Lists the four models the
 * UI exposes, the always-on thinking config each one uses, and the effort
 * ("thinking power") options. Keep this file dependency-free so the API route
 * can import it without dragging in any React or browser-only code.
 *
 * Naming convention matches Anthropic's documented model IDs. Only CURRENT
 * Claude tiers are listed — Fable 5.1, Opus 5.5, Sonnet 5. Every superseded id
 * (Fable 5, Opus 5/4.8/4.7, Sonnet 4.6, Haiku 4.5) was dropped from the picker
 * and lives on only in `RETIRED_MODEL_IDS`, which re-points persisted
 * conversations at its successor. `claude-sonnet-5` is the floor; the
 * Mythos-class flagship `claude-fable-5-1` (released 2026-08-28) dashes its
 * point release, the same way the Opus and Sonnet tiers always have. The
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
  | 'claude-fable-5-1'
  | 'claude-opus-5-5'
  | 'claude-sonnet-5'
  | 'deepseek-v4-pro'
  | 'deepseek-flash'
  | 'deepseek/deepseek-v4.1-flash'
  | 'moonshotai/kimi-k3'
  | 'kimi-k3-code'
  | 'kimi-k3'
  | 'glm-5.3'
  | 'z-ai/glm-5.3-flash'
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
  | 'moonshot'
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
    // thinking is always on and is the only thinking mode it supports —
    // confirmed against the Models API, which reports the `enabled` thinking
    // type as unsupported and only `adaptive` as supported. 1M input, 128k
    // output, full effort ladder low → max.
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    shortLabel: 'Fable 5.1',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
  },
  {
    // Current Opus — Anthropic's flagship for complex agentic coding and
    // enterprise work, released 2026-09-22 as the successor to Opus 5. Cheaper
    // than Opus 5 ($4/$20 vs $5/$25 per MTok), ~40% lower typical-workload cost
    // and faster output; 1M context, 128k max output. Adaptive thinking is on
    // by default (omitting `thinking` still thinks); effort defaults to high,
    // and `budget_tokens` is rejected (400) — the low → max effort ladder is
    // the depth knob.
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    shortLabel: 'Opus 5.5',
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
    //
    // NOTE (from DeepSeek's pricing docs, read 2026-09-10): from 2026-09-14
    // every deepseek-v4-pro request is routed to V4.1-Flash and billed at the
    // Flash price. After that date this entry is a second, pricier-labelled
    // door onto the same model as the entry below, and should be retired.
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    shortLabel: 'DS V4 Pro',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'deepseek',
  },
  {
    // The efficiency tier, currently serving DeepSeek-V4.1-Flash: 1M context,
    // 384k max output, and a quarter to a third of Pro's price depending on
    // token type (output 3.3x cheaper, uncached input 4.4x, cache hits 7.3x).
    // Thinking is on by default here and CAN be switched off per request,
    // unlike Pro.
    //
    // `deepseek-flash` is a FLOATING alias, and it is the only flash id the
    // live /models endpoint advertises — the version lives in the label, not
    // the id, so the next point release needs a label change and nothing more.
    // The older `deepseek-v4-flash` is a legacy name DeepSeek still accepts and
    // routes here; it is retired below rather than kept, since an id the
    // provider no longer lists is one deprecation notice away from breaking.
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    shortLabel: 'DS V4.1 Flash',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'deepseek',
  },
  {
    // The same V4.1-Flash as the first-party entry above, billed through
    // OpenRouter rather than a DeepSeek account — a second door drawing down a
    // different balance.
    //
    // Routed through the `@preset/deepseek-v4-1-flash-fp8` OpenRouter preset
    // (see `wireId`), NOT the bare slug. The bare slug load-balances across
    // every host, and OpenRouter's DeepSeek fleet includes fp4 hosts (Relace,
    // Sail Research) whose 50% discount buys degraded weights, plus a spread of
    // undeclared-quantisation hosts. The preset allows only declared
    // fp8-or-better quantisations (no fp4, no `unknown`) and sorts by price, so
    // it lands on the cheapest reference-quality host — DeepInfra fp8 at
    // $0.14/$0.42 per Mtok, verified 2026-09-19 — failing over only to other
    // fp8 hosts. Same lever as the GLM entry below; the preset lives in the
    // OpenRouter account behind OPENROUTER_API_KEY.
    id: 'deepseek/deepseek-v4.1-flash',
    wireId: '@preset/deepseek-v4-1-flash-fp8',
    label: 'DeepSeek V4.1 Flash (OpenRouter)',
    shortLabel: 'DS Flash (OR)',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'openrouter',
    contextWindow: 1_048_576,
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
    // The same Moonshot model again, on the THIRD of the three routes to it:
    // Moonshot's own pay-as-you-go developer API, billed per token against a
    // prepaid balance. Distinct from both siblings above —
    //
    //   moonshotai/kimi-k3  marketplace (OpenRouter), per-token, host roulette
    //   kimi-k3-code        Kimi Code subscription, flat rate, `k3` on the wire
    //   kimi-k3 (this one)  Moonshot direct, per-token, first-party
    //
    // Worth keeping all three: the subscription has usage windows that run
    // out, OpenRouter's quality varies with whichever host it picks, and this
    // route is the one that always works at a predictable price. `kimi-k3` is
    // the id Moonshot's own catalog publishes, so it goes on the wire verbatim
    // — no `wireId` needed.
    //
    // Verified live against the endpoint: 1,048,576 context, 131k max output,
    // tool calling, prompt caching, and thinking that is always on
    // (`supports_thinking_type: "only"` — it cannot be turned off).
    id: 'kimi-k3',
    label: 'Kimi K3 (Moonshot API)',
    shortLabel: 'Kimi K3 API',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'moonshot',
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
    // Z.AI's efficiency tier, via OpenRouter. Native multimodal, hybrid
    // sparse/linear attention, 1M context, 131k max output; positioned for
    // coding and long-horizon agent work at a sixth of GLM 5.3's price.
    // OpenRouter is the only route: the coding-plan endpoint above is
    // subscription-gated, and this model is not on it.
    //
    // Routed through the `@preset/glm-5-3-flash-fp8` OpenRouter preset (see
    // `wireId`), NOT the bare slug: this model has 29 hosts on OpenRouter and
    // no slug suffix can pin their precision. Measured 2026-09-19, three runs
    // each through the same /v1/messages endpoint the CLI dials:
    //
    //   bare      Parasail, StreamLake  declared fp8   $0.15/$0.50 per Mtok
    //   :nitro    Together ×3           undeclared     $0.15/$0.50
    //   :floor    Relace/Together/…     mixed          $0.09–0.15
    //   :exacto   InferenceNet, DeepInfra  fp4         $0.075 — and DeepInfra
    //                                                   returned ONE output token
    //
    // fp8 is the precision Z.AI serves first-party at $0.15/$0.50 per Mtok, so
    // reference quality lives on the fp8 hosts; `:floor`/`:exacto` chase the
    // fp4 hosts whose 50% discount buys degraded weights, and `:nitro` pins an
    // undeclared-precision host for no saving.
    //
    // So this entry pins routing with a PRESET: `@preset/glm-5-3-flash-fp8`
    // allows only declared fp8-or-better quantisations (no fp4/nvfp4, no
    // `unknown`) and sorts by price, landing on Z.AI/StreamLake fp8 — verified
    // 2026-09-19 to serve the full tools+thinking+streaming payload. A body
    // `provider` filter DOES work on OpenRouter's `/v1/messages` (verified —
    // the earlier "changes nothing" note was wrong), but the spawned CLI can't
    // add body fields, so the preset, carried as the model id, is the only
    // lever that works for both the CLI and OpenCode backends.
    //
    // Not offered: `:batch` (async, not a chat endpoint) and `glm-5.3-flashx`,
    // the 200 tok/s variant at $0.37/$1.25 — 2.5× the price for speed alone.
    id: 'z-ai/glm-5.3-flash',
    wireId: '@preset/glm-5-3-flash-fp8',
    label: 'GLM 5.3 Flash (OpenRouter)',
    shortLabel: 'GLM Flash (OR)',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
    provider: 'openrouter',
    contextWindow: 1_048_576,
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

export const DEFAULT_MODEL_ID: ModelId = 'claude-opus-5-5';

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
  // Legacy Opus, likewise dropped — now including Opus 5 itself, retired
  // forward to its 5.5 point release: cheaper per token ($4/$20 vs $5/$25),
  // same 1M context, 128k output, and adaptive-only thinking, so a pinned
  // conversation moves straight across. The older two map UP to the current
  // Opus rather than across to Sonnet — someone who chose Opus wanted the
  // frontier tier.
  'claude-opus-5': 'claude-opus-5-5',
  'claude-opus-4-8': 'claude-opus-5-5',
  'claude-opus-4-7': 'claude-opus-5-5',
  // Fable 5 → 5.1 is a point release within the same flagship tier: same 1M
  // context, same 128k output, same adaptive-only thinking, same price. So a
  // conversation pinned to it moves straight across rather than landing on a
  // different tier the way the entries above have to.
  'claude-fable-5': 'claude-fable-5-1',
  // DeepSeek renamed its flash tier to a floating `deepseek-flash` alias when
  // V4.1-Flash shipped. Same tier, same 1M context, same price — so this is a
  // straight-across move like the Fable entry above, not a tier change.
  'deepseek-v4-flash': 'deepseek-flash',
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
 * `moonshotai/kimi-k3` → `MOONSHOTAI_KIMI_K3`, for per-model env-var naming.
 * Shared by both backends' wire overrides so one model is spelled one way in
 * `CLAUDECHAT_SDK_MODEL_*` and `CLAUDECHAT_OPENCODE_MODEL_*` alike.
 */
export function modelEnvSuffix(id: ModelId): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
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
