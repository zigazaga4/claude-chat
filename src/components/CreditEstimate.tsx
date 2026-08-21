'use client';

import { useEffect, useState } from 'react';
import { Coins, Moon, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ModelId } from '@/lib/models';
import {
  estimateSend,
  formatCredits,
  isCreditBilled,
  QWEN_PLAN_TIERS,
} from '@/lib/qwenCredits';

type Props = {
  model: ModelId;
  /** Live context footprint — the same number the token gauge shows. */
  contextTokens: number;
  /** Unsent draft text. */
  draft: string;
  /** Whether the last call reported prompt-cache reads. */
  cacheWarm: boolean;
};

/**
 * Estimated credit cost of the next send, for models billed in Token Plan
 * credits rather than per-token currency.
 *
 * Two facts drive the number and neither is obvious from a token count alone:
 * the whole conversation is re-billed on every API call, and a prompt-cache
 * hit prices that conversation at a tenth. So the same message can cost 26
 * credits cold and 4 warm — which is exactly what this chip makes visible
 * before the user commits to sending.
 *
 * Renders nothing for models that aren't credit-billed, so the composer is
 * unchanged on Claude/GLM/DeepSeek/Kimi.
 */
export default function CreditEstimate({
  model,
  contextTokens,
  draft,
  cacheWarm,
}: Props) {
  // The off-peak window opens and closes on a wall clock, so the estimate has
  // to re-render on its own. A minute is far finer than the hour boundary it
  // is watching for, and costs nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!isCreditBilled(model)) return null;

  const est = estimateSend({ model, contextTokens, draft, cacheWarm, now });

  // Share of the smallest plan's 5-hour window, as the most legible unit of
  // "is this a lot?" — Lite is where a single expensive send actually bites.
  const lite = QWEN_PLAN_TIERS[0];
  const pctOfWindow = (est.loopCredits / lite.fiveHour) * 100;

  const tone = est.loopCredits >= 100
    ? 'text-red-300'
    : est.loopCredits >= 30
      ? 'text-amber-300'
      : 'text-muted-foreground';

  const title = [
    `Estimated cost of sending this message`,
    ``,
    `One API call:  ~${formatCredits(est.credits)} credits`,
    `Typical turn:  ~${formatCredits(est.loopCredits)} credits (≈6 calls — every tool round-trip re-sends the conversation)`,
    ``,
    est.cached
      ? `Cache: WARM — the ${contextTokens.toLocaleString()} tokens already in context bill at 1/10 rate.`
      : `Cache: COLD — the full ${contextTokens.toLocaleString()}-token context bills at fresh input rate (10x warm). It warms after the first call.`,
    est.night
      ? `Off-peak: 50% discount active (22:00–08:00 Beijing).`
      : `Full rate. Off-peak (50% off) runs 22:00–08:00 Beijing time.`,
    ``,
    `≈${pctOfWindow.toFixed(1)}% of a Lite 5-hour window (${lite.fiveHour.toLocaleString()} credits).`,
    ``,
    `Approximate: Alibaba varies credit rates by model, thinking mode, and tool calls.`,
  ].join('\n');

  return (
    <div
      className="flex items-center gap-1 text-xs text-muted-foreground"
      title={title}
    >
      <Coins className={cn('h-3.5 w-3.5', tone)} />
      <span className={cn('tabular-nums font-medium', tone)}>
        ~{formatCredits(est.loopCredits)}
      </span>
      {est.cached ? (
        <Zap
          className="h-3 w-3 text-emerald-400"
          aria-label="Prompt cache warm"
        />
      ) : (
        <span
          className="text-[10px] uppercase tracking-wide text-amber-400/80"
          aria-label="Prompt cache cold"
        >
          cold
        </span>
      )}
      {est.night && (
        <Moon className="h-3 w-3 text-sky-400" aria-label="Off-peak rate" />
      )}
    </div>
  );
}
