'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ToolStatus = 'pending' | 'done' | 'error';

export type ToolTone = {
  /** Background gradient for the icon chip + left accent stripe */
  stripe: string;
  /** Icon foreground color */
  icon: string;
};

type ToolShellProps = {
  name: string;
  Icon: LucideIcon;
  tone: ToolTone;
  summary?: ReactNode;
  status: ToolStatus;
  defaultOpen?: boolean;
  /**
   * When defined, drives the open state externally and re-syncs whenever
   * the value changes. Used to auto-open the latest write/edit block while
   * collapsing earlier ones.
   */
  forceOpen?: boolean;
  body?: ReactNode;
  /** Optional extra status label (e.g. "running in background"). */
  statusLabel?: ReactNode;
  /**
   * True while the model is still streaming the tool's input JSON. The
   * shell shows a pulsing border + ignores the body until the input
   * arrives, so big Edit/Write calls don't sit silently for many seconds.
   */
  streaming?: boolean;
};

export function ToolShell({
  name,
  Icon,
  tone,
  summary,
  status,
  defaultOpen,
  forceOpen,
  body,
  statusLabel,
  streaming,
}: ToolShellProps) {
  const [open, setOpen] = useState(forceOpen ?? defaultOpen ?? status === 'error');

  // Sync `forceOpen` during render (React's "adjust state when a prop
  // changes" pattern) instead of in an effect, avoiding a cascading render.
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen !== undefined) setOpen(forceOpen);
  }

  const borderClass = streaming
    ? 'border-blue-400/60 animate-pulse'
    : status === 'error'
      ? 'border-red-500/40'
      : status === 'pending'
        ? 'border-blue-400/40'
        : 'border-border/50';

  const bgClass =
    status === 'error'
      ? 'bg-red-500/[0.04]'
      : status === 'pending' || streaming
        ? 'bg-blue-500/[0.04]'
        : 'bg-card/40';

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border text-xs transition-colors',
        borderClass,
        bgClass,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-0.5', tone.stripe)}
      />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground/90 hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            status === 'error' ? 'text-red-400' : tone.icon,
          )}
        />
        <span className="font-mono text-[12px] font-semibold tracking-tight">{name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide">
          {statusLabel ?? <StatusBadge status={status} />}
        </span>
      </button>
      {open && body && !streaming && (
        <div className="border-t border-border/40 bg-background/40 px-3 py-2.5">
          {body}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ToolStatus }) {
  if (status === 'error') return <span className="text-red-400">error</span>;
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-blue-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
        running
      </span>
    );
  }
  return <span className="text-emerald-400">done</span>;
}

export function statusOf(result: { isError?: boolean } | undefined): ToolStatus {
  if (!result) return 'pending';
  if (result.isError) return 'error';
  return 'done';
}

export function asInputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

export function shortPath(p: string, max = 60): string {
  if (p.length <= max) return p;
  const tail = p.slice(-max + 1);
  const slash = tail.indexOf('/');
  return `…${slash >= 0 ? tail.slice(slash) : tail}`;
}

export function CodeBlock({
  children,
  className,
  maxHeight = 'max-h-72',
}: {
  children: ReactNode;
  className?: string;
  maxHeight?: string;
}) {
  return (
    <pre
      className={cn(
        'scrollbar-thin overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-background/70 p-2 font-mono text-[11.5px] leading-relaxed',
        maxHeight,
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}
