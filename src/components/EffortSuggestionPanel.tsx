'use client';

import { Check, Wand2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { EFFORT_LABELS, type EffortLevel, type EffortSuggestion } from '@/lib/models';

type Props = {
  suggestion: EffortSuggestion;
  currentEffort: EffortLevel;
  /** Accept the suggestion: switch to the suggested effort and send. */
  onAccept: () => void;
  /** Reject the suggestion: send with the current effort, unchanged. */
  onReject: () => void;
  /** Dismiss without sending — the message returns to the composer. */
  onCancel: () => void;
};

/**
 * Accept/reject card shown after the auto-effort classifier recommends an
 * effort for the message the user just submitted. The message is held — not
 * sent — until the user picks: Accept (use the suggestion), Reject (keep the
 * current effort), or Cancel (put the text back in the composer).
 */
export default function EffortSuggestionPanel({
  suggestion,
  currentEffort,
  onAccept,
  onReject,
  onCancel,
}: Props) {
  const sameAsCurrent = suggestion.effort === currentEffort;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-teal-400/30 bg-teal-500/[0.07] px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-300" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] leading-snug text-foreground/90">
            Suggested thinking effort:{' '}
            <span className="font-semibold text-teal-200">
              {EFFORT_LABELS[suggestion.effort]}
            </span>
            {sameAsCurrent && (
              <span className="ml-1 text-[11px] text-muted-foreground">
                (matches your current setting)
              </span>
            )}
          </div>
          {suggestion.reason && (
            <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {suggestion.reason}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Cancel — keep editing"
          title="Cancel — return the message to the composer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 pl-5">
        <button
          type="button"
          onClick={onAccept}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-teal-500/50 bg-teal-500/15 px-2 py-1 text-[11px] font-medium text-teal-100',
            'transition-colors hover:bg-teal-500/25',
          )}
          title={`Send using ${EFFORT_LABELS[suggestion.effort]} effort`}
        >
          <Check className="h-3 w-3" />
          Use {EFFORT_LABELS[suggestion.effort]}
        </button>
        <button
          type="button"
          onClick={onReject}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-[11px] font-medium text-muted-foreground',
            'transition-colors hover:bg-muted hover:text-foreground',
          )}
          title={`Ignore the suggestion and send with ${EFFORT_LABELS[currentEffort]} effort`}
        >
          Keep {EFFORT_LABELS[currentEffort]}
        </button>
      </div>
    </div>
  );
}
