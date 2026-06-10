'use client';

type TokenCircleProps = {
  used: number;
  total: number;
};

function fmtCompact(n: number) {
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

export default function TokenCircle({ used, total }: TokenCircleProps) {
  if (total <= 0) return null;
  const pct = Math.min(100, (used / total) * 100);
  const r = 10;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;

  const ringColor = pct < 50 ? '#e8837e' : pct < 75 ? '#f59e0b' : '#ef4444';
  const tooltip = `${used.toLocaleString()} / ${total.toLocaleString()} tokens (${pct.toFixed(1)}%)`;

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={tooltip}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" className="-rotate-90">
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          strokeWidth="2"
          className="stroke-border"
        />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="tabular-nums">
        <span className="font-medium text-foreground">{fmtCompact(used)}</span>
        <span className="text-muted-foreground/70">/{fmtCompact(total)}</span>
        <span className="ml-1 text-muted-foreground/60">({pct.toFixed(1)}%)</span>
      </span>
    </div>
  );
}
