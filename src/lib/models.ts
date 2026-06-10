/**
 * Model registry shared between client and server. Lists the four models the
 * UI exposes, the always-on thinking config each one uses, and the effort
 * ("thinking power") options. Keep this file dependency-free so the API route
 * can import it without dragging in any React or browser-only code.
 *
 * Naming convention (`claude-{family}-{major}-{minor}`) matches the Anthropic
 * SDK's documented model IDs — `claude-opus-4-6`, `claude-sonnet-4-6`,
 * `claude-haiku-4-5` are in the SDK's `Model` enum; `claude-opus-4-7` is the
 * docs' canonical Opus 4.7 example; `claude-opus-4-8` follows the same pattern.
 * The Mythos-class flagship `claude-fable-5` (released 2026-06-09) uses a
 * single version number, matching Anthropic's published ID. The `model` option
 * is a free-form string the CLI resolves, so no SDK version bump is required.
 *
 * Thinking model: adaptive thinking ("Claude decides when and how much to
 * think", Opus 4.6+) is ALWAYS ON for the models that support it — it isn't a
 * user toggle. Haiku has no adaptive mode, so it runs extended thinking
 * (always on too). The user-facing picker chooses the EFFORT level only,
 * which the SDK docs describe as the knob that "works with adaptive thinking
 * to guide thinking depth."
 */

export type ModelId =
  | 'claude-fable-5'
  | 'claude-opus-4-8'
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

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
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    shortLabel: 'Opus 4.8',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    shortLabel: 'Opus 4.7',
    thinkingType: 'adaptive',
    defaultEffort: 'xhigh',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    shortLabel: 'Sonnet 4.6',
    thinkingType: 'adaptive',
    defaultEffort: 'high',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    shortLabel: 'Haiku 4.5',
    thinkingType: 'extended',
    defaultEffort: 'high',
  },
];

export const DEFAULT_MODEL_ID: ModelId = 'claude-opus-4-8';

/**
 * Model used by the "auto effort" feature to classify a request and recommend
 * a thinking-effort level before the main turn starts. Sonnet 4.6 is fast and
 * cheap enough to gate every first message without adding noticeable latency.
 */
export const SUGGESTION_MODEL_ID: ModelId = 'claude-sonnet-4-6';

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
