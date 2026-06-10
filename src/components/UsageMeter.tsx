'use client';

import { Activity } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PlanUsageWindow } from '@/lib/types';
import { usePlanUsage, useRateLimitUsage } from '@/state/usage';

const LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  seven_day_opus: '7-day Opus window',
  seven_day_sonnet: '7-day Sonnet window',
  overage: 'Overage',
};

/** One tooltip line for a plan window: "5-hour: 32% used — resets in 2h 10m". */
function windowLine(
  label: string,
  w: PlanUsageWindow | null | undefined,
): string | null {
  if (!w || typeof w.utilization !== 'number') return null;
  const reset = formatReset(w.resetsAt ?? undefined);
  return `${label}: ${Math.round(w.utilization)}% used${reset ? ` — ${reset}` : ''}`;
}

function formatReset(resetsAt: number | undefined): string | null {
  if (!resetsAt) return null;
  const deltaMs = resetsAt - Date.now();
  if (deltaMs <= 0) return 'resets soon';
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.round(hours / 24)}d`;
}

/**
 * Top-bar subscription usage meter — the same numbers Claude Code's /usage
 * command shows. Primary source is the structured plan-usage data (per-window
 * percentages, fetched after every loop); the live rate_limit_event is the
 * fallback before the first /usage snapshot lands. Shows the 5-hour window
 * percentage with a small bar; color shifts green → amber → red as the window
 * fills. Renders nothing until the first snapshot arrives (the SDK only
 * reports usage once a stream runs).
 */
export default function UsageMeter() {
  const plan = usePlanUsage();
  const usage = useRateLimitUsage();
  if (!plan && !usage) return null;

  // Headline percentage: the 5-hour window (Claude Code's main gauge), then
  // the 7-day window, then whatever the live rate_limit_event carried.
  const headline =
    typeof plan?.fiveHour?.utilization === 'number'
      ? { pct: plan.fiveHour.utilization, label: '5-hour window', resetsAt: plan.fiveHour.resetsAt ?? undefined }
      : typeof plan?.sevenDay?.utilization === 'number'
        ? { pct: plan.sevenDay.utilization, label: '7-day window', resetsAt: plan.sevenDay.resetsAt ?? undefined }
        : typeof usage?.utilization === 'number'
          ? {
              pct: usage.utilization,
              label: usage.rateLimitType
                ? (LIMIT_TYPE_LABELS[usage.rateLimitType] ?? usage.rateLimitType)
                : 'Usage',
              resetsAt: usage.resetsAt,
            }
          : null;

  const hasPct = headline !== null;
  // The wire value is a percentage of the window already used. Clamp to the
  // meter's [0, 100] domain — overage can push readings past 100.
  const pct = hasPct ? Math.min(100, Math.max(0, headline.pct)) : 0;
  const rejected = usage?.status === 'rejected';
  const warning =
    usage?.status === 'allowed_warning' || (hasPct && pct >= 80);

  const barColor = rejected
    ? 'bg-red-400'
    : warning
      ? 'bg-amber-400'
      : 'bg-emerald-400';
  const textColor = rejected
    ? 'text-red-300'
    : warning
      ? 'text-amber-300'
      : 'text-emerald-300';

  const reset = formatReset(headline?.resetsAt);
  // Tooltip: every window the plan exposes, one line each — the full /usage
  // readout on hover.
  const extra = plan?.extraUsage;
  const title = [
    windowLine('5-hour window', plan?.fiveHour),
    windowLine('7-day window', plan?.sevenDay),
    windowLine('7-day Opus window', plan?.sevenDayOpus),
    windowLine('7-day Sonnet window', plan?.sevenDaySonnet),
    extra?.isEnabled && typeof extra.usedCredits === 'number'
      ? `Extra usage: ${extra.usedCredits}${extra.monthlyLimit != null ? ` / ${extra.monthlyLimit}` : ''} credits`
      : null,
    !plan && hasPct ? `${headline.label}: ${Math.round(headline.pct)}% used` : null,
    !hasPct ? (rejected ? 'limit reached' : warning ? 'nearing limit' : 'within limits') : null,
    !plan ? reset : null,
    usage?.isUsingOverage ? 'currently using overage' : null,
    rejected ? 'rate limit reached' : null,
  ]
    .filter(Boolean)
    .join('\n');

  // Compact status word for the no-percentage fallback.
  const statusWord = rejected ? 'Limit' : warning ? 'Near' : 'OK';

  return (
    <div
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 py-1"
      title={title}
    >
      <Activity className={cn('h-3.5 w-3.5', textColor)} />
      {hasPct ? (
        <>
          <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted-foreground/20 sm:w-20">
            <div
              className={cn('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn('text-[11px] font-medium tabular-nums', textColor)}>
            {Math.round(pct)}%
          </span>
        </>
      ) : (
        <>
          <span className={cn('h-1.5 w-1.5 rounded-full', barColor)} />
          <span className={cn('text-[11px] font-medium', textColor)}>
            {statusWord}
          </span>
          {reset && (
            <span className="hidden text-[10px] text-muted-foreground sm:inline">
              {reset}
            </span>
          )}
        </>
      )}
    </div>
  );
}
