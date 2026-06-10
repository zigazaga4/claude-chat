'use client';

import { Wand2 } from 'lucide-react';
import { cn } from '@/lib/cn';

type Props = {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
};

/**
 * On/off pill for the "auto effort" feature. When on, the first message of a
 * conversation turn is routed through a classifier that recommends a thinking
 * effort, which the user accepts or rejects before the turn actually starts.
 */
export default function AutoEffortToggle({ enabled, onChange, disabled }: Props) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      aria-pressed={enabled}
      title={
        enabled
          ? 'Auto effort is ON — Claude suggests a thinking effort for each new message'
          : 'Auto effort is OFF — click to let Claude suggest a thinking effort per message'
      }
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        enabled
          ? 'border-teal-500/45 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15'
          : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Wand2 className="h-3.5 w-3.5" />
      <span className="whitespace-nowrap">Auto</span>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          enabled ? 'bg-teal-400' : 'bg-muted-foreground/50',
        )}
      />
    </button>
  );
}
