'use client';

import { FoldVertical } from 'lucide-react';
import { cn } from '@/lib/cn';
import { autoCompactChoices, autoCompactLimit } from '@/lib/autoCompact';
import { formatTokensCompact } from '@/lib/formatTokens';

type Props = {
  /** Threshold in tokens; 0 = off. */
  value: number;
  onChange: (tokens: number) => void;
  /** The current model's window, which bounds what can be offered. */
  contextWindow: number;
  disabled?: boolean;
  /**
   * Why the setting cannot apply here (shown as the tooltip). When set the
   * control is inert and reads "Off" whatever is stored, so a stored value
   * never looks like it is doing something it is not.
   */
  unavailableReason?: string;
};

/**
 * Auto-compact threshold picker.
 *
 * When a running task's context reaches the chosen size, the loop is paused
 * between tool calls, the conversation is compacted, and the model is told to
 * continue — see `lib/autoCompact.ts`. A native `<select>` on purpose: it gives
 * phones their own picker for free, and the list is a plain set of sizes.
 */
export default function AutoCompactPicker({
  value,
  onChange,
  contextWindow,
  disabled,
  unavailableReason,
}: Props) {
  const choices = autoCompactChoices(contextWindow);
  const reason =
    unavailableReason ??
    (choices.length === 0
      ? "This model's context window is too small for auto-compact"
      : undefined);
  const shown = reason ? 0 : value;
  const inert = disabled || !!reason;

  // A stored value the model's window no longer allows (the user switched to a
  // smaller model) or that is not one of the steps stays selectable: silently
  // showing a different number than the one in effect would be worse.
  const overWindow = shown > autoCompactLimit(contextWindow);
  const options =
    shown === 0 || choices.includes(shown)
      ? choices
      : [...choices, shown].sort((a, b) => a - b);

  const on = shown > 0 && !overWindow;
  const title = reason
    ? `Auto-compact unavailable — ${reason}`
    : overWindow
      ? `Auto-compact is set to ${shown.toLocaleString()} tokens, which is above this model's window — it will not run. Pick a lower value.`
      : on
        ? `Auto-compact is ON — when a running task's context reaches ${shown.toLocaleString()} tokens, the loop pauses between tool calls, the conversation is compacted, and the model is told to continue. Changes apply immediately, even mid-run.`
        : 'Auto-compact is OFF — pick a token size to compact the conversation and continue automatically.';

  return (
    <label
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        inert ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        on
          ? 'border-violet-500/45 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
          : overWindow
            ? 'border-amber-500/45 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15'
            : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <FoldVertical className="h-3.5 w-3.5" />
      <span className="hidden whitespace-nowrap sm:inline">Auto-compact</span>
      <select
        value={shown}
        disabled={inert}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Auto-compact threshold"
        className="cursor-[inherit] appearance-none bg-transparent pr-0.5 text-xs font-medium outline-none disabled:cursor-not-allowed [&>option]:bg-background [&>option]:text-foreground"
      >
        <option value={0}>Off</option>
        {options.map((t) => (
          <option key={t} value={t}>
            {formatTokensCompact(t)}
            {t > autoCompactLimit(contextWindow) ? ' (too high)' : ''}
          </option>
        ))}
      </select>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          on
            ? 'bg-violet-400'
            : overWindow
              ? 'bg-amber-400'
              : 'bg-muted-foreground/50',
        )}
      />
    </label>
  );
}
