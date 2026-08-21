/**
 * Credit pricing for models billed against Alibaba's Model Studio Token Plan.
 *
 * The Token Plan does not meter requests — it meters TOKENS, per API call, and
 * re-bills the whole conversation every call. Three rates apply, and the gap
 * between them is the whole story:
 *
 *   input   0.0002    credits/token   fresh context
 *   cached  0.00002   credits/token   prompt-cache hit — 10x cheaper
 *   output  0.0012    credits/token   generated tokens — 6x input
 *
 * Derived from Alibaba's own published worked example, which is the only
 * per-token breakdown they document:
 *
 *   input   8,349 tokens →  1.67 credits   (÷ = 0.00020002)
 *   cached 40,794 tokens →  0.82 credits   (÷ = 0.0000201)
 *   output    573 tokens →  0.69 credits   (÷ = 0.0012042)
 *
 * Treat these as a floor, not a contract: Alibaba states credits are
 * "dynamically determined by model type, token usage, thinking mode, and tool
 * calls", and the flagship costs more per token than lighter tiers. Everything
 * here is therefore an ESTIMATE, and the UI says so.
 *
 * Keep this file dependency-free — it is imported by both the composer and
 * (potentially) the server.
 */

import { getProvider, type ModelId } from './models';

/** Credits per token, by how the token was counted. */
export type CreditRates = {
  input: number;
  cached: number;
  output: number;
};

export const QWEN_CREDIT_RATES: CreditRates = {
  input: 0.0002,
  cached: 0.00002,
  output: 0.0012,
};

/**
 * Whether a model bills in Token Plan credits rather than per-token currency.
 * Only the Qwen provider does today; keep the check narrow so no other
 * provider pays for it.
 */
export function isCreditBilled(model: ModelId): boolean {
  return getProvider(model) === 'qwen';
}

/**
 * Off-peak discount window, in UTC+8 (Beijing) hours: 22:00 → 08:00.
 *
 * Alibaba discounts qwen3.8-max credit consumption by 50% inside it. The
 * window is defined in Beijing time regardless of where the user sits, so it
 * is computed from UTC rather than local time — for Europe/Bucharest that
 * lands at roughly 17:00–03:00, i.e. most of an evening's work.
 */
const NIGHT_START_UTC8 = 22;
const NIGHT_END_UTC8 = 8;
const NIGHT_MULTIPLIER = 0.5;

/** Hour of day in UTC+8 for an epoch-ms instant. */
export function beijingHour(now: number): number {
  return new Date(now + 8 * 3_600_000).getUTCHours();
}

/** Whether `now` falls in the off-peak (discounted) window. */
export function isNightRate(now: number): boolean {
  const h = beijingHour(now);
  return h >= NIGHT_START_UTC8 || h < NIGHT_END_UTC8;
}

/** Multiplier applied to credit consumption at `now`. 1 = full price. */
export function rateMultiplier(model: ModelId, now: number): number {
  // Only the flagship is documented as discounted; other Token Plan models
  // have their own (smaller) off-peak rates we have not verified, so they are
  // charged at full price here rather than guessed at.
  if (model !== 'qwen3.8-max') return 1;
  return isNightRate(now) ? NIGHT_MULTIPLIER : 1;
}

export type TokenSplit = {
  /** Fresh (uncached) input tokens. */
  input: number;
  /** Input tokens served from the prompt cache. */
  cached: number;
  /** Generated tokens, including thinking. */
  output: number;
};

/** Credits one API call with this token split costs. */
export function creditsFor(split: TokenSplit, multiplier = 1): number {
  const raw =
    split.input * QWEN_CREDIT_RATES.input +
    split.cached * QWEN_CREDIT_RATES.cached +
    split.output * QWEN_CREDIT_RATES.output;
  return raw * multiplier;
}

/**
 * Rough token count for a draft message.
 *
 * ~4 characters per token is the standard English approximation and is all
 * that is warranted here: the number is a pre-send estimate shown beside an
 * explicitly approximate cost, and a real tokenizer would cost a network
 * round-trip per keystroke.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Typical generated tokens per API call, used when estimating a send.
 *
 * Deliberately conservative: agentic calls mostly emit a short burst of text
 * plus a tool call, and it is the *input* side that dominates cost on a long
 * conversation. Under-guessing output keeps the estimate honest about what
 * the user controls (context length) instead of drowning it in a guess about
 * how chatty the model will be.
 */
const ASSUMED_OUTPUT_TOKENS = 700;

export type SendEstimate = {
  /** Credits for the next single API call. */
  credits: number;
  /** Credits if the turn runs a typical agentic loop of several calls. */
  loopCredits: number;
  /** Whether the context is expected to be served from cache. */
  cached: boolean;
  /** Whether the off-peak discount applies right now. */
  night: boolean;
  /** Token split the estimate was built from. */
  split: TokenSplit;
};

/**
 * Calls a typical agentic turn makes. Each tool round-trip re-sends the whole
 * conversation, which is why a turn costs several times one call.
 */
const ASSUMED_LOOP_CALLS = 6;

/**
 * Estimate what sending the current draft will cost.
 *
 * @param contextTokens Live context footprint (what the meter shows) — the
 *   conversation that will be re-sent with this message.
 * @param draft The unsent message text.
 * @param cacheWarm Whether the last call reported cache reads. A warm cache
 *   bills the conversation at a tenth; a cold one bills it at full input rate,
 *   which is the single biggest swing in the estimate.
 */
export function estimateSend(opts: {
  model: ModelId;
  contextTokens: number;
  draft: string;
  cacheWarm: boolean;
  now: number;
}): SendEstimate {
  const draftTokens = estimateTokens(opts.draft);
  const context = Math.max(0, opts.contextTokens);
  // A warm cache covers the existing conversation; the new message is always
  // fresh input. A cold one pays full input rate for everything.
  const split: TokenSplit = opts.cacheWarm
    ? { input: draftTokens, cached: context, output: ASSUMED_OUTPUT_TOKENS }
    : { input: context + draftTokens, cached: 0, output: ASSUMED_OUTPUT_TOKENS };
  const multiplier = rateMultiplier(opts.model, opts.now);
  const credits = creditsFor(split, multiplier);
  // Later calls in a loop always hit a warm cache — the first call primed it.
  const warmSplit: TokenSplit = {
    input: 0,
    cached: context + draftTokens,
    output: ASSUMED_OUTPUT_TOKENS,
  };
  const loopCredits =
    credits + creditsFor(warmSplit, multiplier) * (ASSUMED_LOOP_CALLS - 1);
  return {
    credits,
    loopCredits,
    cached: opts.cacheWarm,
    night: multiplier < 1,
    split,
  };
}

/** Token Plan (Personal) quotas, for expressing an estimate as % of a window. */
export type PlanTier = {
  id: 'lite' | 'standard' | 'pro';
  label: string;
  /** USD per month at launch pricing. */
  price: number;
  fiveHour: number;
  sevenDay: number;
};

export const QWEN_PLAN_TIERS: PlanTier[] = [
  { id: 'lite', label: 'Lite', price: 6, fiveHour: 700, sevenDay: 2_500 },
  { id: 'standard', label: 'Standard', price: 18, fiveHour: 3_000, sevenDay: 10_000 },
  { id: 'pro', label: 'Pro', price: 68, fiveHour: 12_000, sevenDay: 40_000 },
];

/** Display helper: "0.42" / "4.1" / "26" — precision that shrinks as the number grows. */
export function formatCredits(credits: number): string {
  if (credits < 1) return credits.toFixed(2);
  if (credits < 10) return credits.toFixed(1);
  return Math.round(credits).toString();
}
