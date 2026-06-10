'use client';

import { Gauge } from 'lucide-react';
import { cn } from '@/lib/cn';
import { EFFORT_LABELS, EFFORT_ORDER, type EffortLevel } from '@/lib/models';

const STYLES: Record<EffortLevel, { btn: string; dot: string }> = {
  low: {
    btn: 'border-slate-500/40 bg-slate-500/10 text-slate-300 hover:bg-slate-500/15',
    dot: 'bg-slate-400',
  },
  medium: {
    btn: 'border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/15',
    dot: 'bg-sky-400',
  },
  high: {
    btn: 'border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/15',
    dot: 'bg-purple-400',
  },
  xhigh: {
    btn: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/15',
    dot: 'bg-fuchsia-400',
  },
  max: {
    btn: 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15',
    dot: 'bg-rose-400',
  },
};

type Props = {
  effort: EffortLevel;
  onChange: (effort: EffortLevel) => void;
  disabled?: boolean;
};

/**
 * Thinking-power picker. Every model supports the full effort ladder
 * (low → max), so the cycle order is model-independent. Adaptive/extended
 * thinking is always on under the hood; this only chooses how hard the model
 * thinks.
 */
export default function EffortPicker({ effort, onChange, disabled }: Props) {
  const s = STYLES[effort];
  const cycle = () => {
    const idx = EFFORT_ORDER.indexOf(effort);
    onChange(EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length]);
  };
  const cycleLabel = EFFORT_ORDER.map((e) => EFFORT_LABELS[e]).join(' → ');
  return (
    <button
      type="button"
      onClick={cycle}
      disabled={disabled}
      title={`Thinking effort: ${EFFORT_LABELS[effort]} — click to cycle (${cycleLabel})`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        s.btn,
      )}
    >
      <Gauge className="h-3.5 w-3.5" />
      <span className="whitespace-nowrap">{EFFORT_LABELS[effort]}</span>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
    </button>
  );
}
