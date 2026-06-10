'use client';

import { ArrowDown, Sparkles } from 'lucide-react';

type CompactBoundaryDividerProps = {
  trigger?: 'manual' | 'auto' | string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
};

function fmtTokens(n: number | undefined) {
  if (n == null) return '?';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `${n}`;
}

function fmtDuration(ms: number | undefined) {
  if (!ms || ms <= 0) return null;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

export default function CompactBoundaryDivider({
  trigger,
  preTokens,
  postTokens,
  durationMs,
}: CompactBoundaryDividerProps) {
  const ratio = preTokens && postTokens && preTokens > 0 ? postTokens / preTokens : null;
  const reductionPct = ratio != null ? Math.max(0, Math.round((1 - ratio) * 100)) : null;
  const duration = fmtDuration(durationMs);
  const triggerLabel =
    trigger === 'manual' ? 'Manual compact' : trigger === 'auto' ? 'Auto compact' : 'Compacted';

  const lineClasses =
    'h-0 flex-1 border-t-2 border-dashed border-violet-500/40';

  return (
    <div className="my-6 px-3 sm:px-0" data-compact-boundary="true">
      <div className="flex items-center gap-3">
        <div className={lineClasses} />
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-violet-500/40 bg-violet-950/40 px-3 py-1.5 text-xs font-medium text-violet-200 shadow-sm">
          <Sparkles className="h-3.5 w-3.5" />
          <span>{triggerLabel}</span>
          {preTokens != null && postTokens != null && (
            <>
              <span className="text-violet-500">·</span>
              <span className="tabular-nums">
                {fmtTokens(preTokens)}
                <ArrowDown className="mx-0.5 inline h-3 w-3" />
                {fmtTokens(postTokens)}
              </span>
              {reductionPct != null && reductionPct > 0 && (
                <span className="rounded bg-violet-800/50 px-1.5 py-0.5 text-[10px] tabular-nums text-violet-100">
                  -{reductionPct}%
                </span>
              )}
            </>
          )}
          {duration && (
            <>
              <span className="text-violet-500">·</span>
              <span className="tabular-nums">{duration}</span>
            </>
          )}
        </div>
        <div className={lineClasses} />
      </div>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        Conversation history above this line was summarized. Earlier messages remain
        visible but are no longer in active context.
      </p>
    </div>
  );
}
