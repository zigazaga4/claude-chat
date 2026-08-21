'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Collapsible status strip for the composer.
 *
 * Both callers show the same thing — a count of pending work plus the list
 * behind it — and both sit directly above the textarea, where every extra row
 * pushes the input further down the screen. Collapsed, the header alone still
 * answers "is anything in flight?"; the list is one click away when the answer
 * matters.
 *
 * The header is the toggle rather than a separate chevron button so the whole
 * strip is a hit target, which is what makes this usable at the 10px type size
 * these summaries render at.
 */

export type PanelTone = 'fuchsia' | 'amber';

const TONES: Record<PanelTone, { shell: string; header: string }> = {
  fuchsia: {
    shell: 'border-fuchsia-400/30 bg-fuchsia-500/[0.06]',
    header: 'text-fuchsia-200/80 hover:text-fuchsia-100',
  },
  amber: {
    shell: 'border-amber-400/30 bg-amber-500/[0.06]',
    header: 'text-amber-200/80 hover:text-amber-100',
  },
};

export default function CollapsiblePanel({
  tone,
  icon,
  summary,
  /**
   * Whether the list starts expanded. Queued messages default open — the user
   * wrote them and needs to see what is about to be sent. Background agents
   * default closed: they are the app's own bookkeeping, and a long run would
   * otherwise sit several rows tall for its whole duration.
   */
  defaultOpen = false,
  children,
}: {
  tone: PanelTone;
  icon: ReactNode;
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const t = TONES[tone];

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border px-2 py-1.5',
        t.shell,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide details' : 'Show details'}
        className={cn(
          'flex w-full items-center gap-1.5 text-left text-[10px] uppercase tracking-wide transition-colors',
          t.header,
        )}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        {icon}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && children}
    </div>
  );
}
