'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { lineDiff, withContext, type DiffLine } from './diff';

type Props = {
  prior: string;
  next: string;
  /** When set, collapse unchanged stretches further than `context` lines from a change. */
  context?: number;
  /** Tailwind max-height class. Default `max-h-96`. */
  maxHeight?: string;
};

export function DiffView({ prior, next, context, maxHeight = 'max-h-96' }: Props) {
  const lines = useMemo(() => {
    const all = lineDiff(prior, next);
    return context != null ? withContext(all, context) : all;
  }, [prior, next, context]);

  return (
    <div
      className={cn(
        'scrollbar-thin overflow-auto rounded-md border border-border/40 bg-background/70 font-mono text-[11.5px] leading-relaxed',
        maxHeight,
      )}
    >
      {lines.map((l, i) => (
        <DiffRow key={i} line={l} />
      ))}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'gap') {
    return (
      <div className="flex items-center border-y border-border/30 bg-muted/20 text-[10.5px] text-muted-foreground/60">
        <span className="inline-block w-10 select-none border-r border-border/30 px-1.5 text-right tabular-nums">
          ⋯
        </span>
        <span className="inline-block w-10 select-none border-r border-border/30 px-1.5 text-right tabular-nums">
          ⋯
        </span>
        <span className="inline-block w-5 select-none border-r border-border/30 text-center">
          ⋯
        </span>
        <span className="px-2 italic">
          {line.gapSize} unchanged line{line.gapSize === 1 ? '' : 's'}
        </span>
      </div>
    );
  }

  const isAdd = line.kind === 'add';
  const isDel = line.kind === 'del';

  return (
    <div
      className={cn(
        'flex whitespace-pre',
        isAdd && 'bg-emerald-500/10 text-emerald-200',
        isDel && 'bg-red-500/10 text-red-300',
        line.kind === 'keep' && 'text-muted-foreground/80',
      )}
    >
      <span
        className={cn(
          'inline-block w-10 select-none border-r border-border/30 px-1.5 text-right tabular-nums',
          isAdd && 'bg-emerald-500/15 text-emerald-300/60',
          isDel && 'bg-red-500/20 text-red-300/80',
          line.kind === 'keep' && 'text-muted-foreground/40',
        )}
      >
        {line.oldNo ?? ''}
      </span>
      <span
        className={cn(
          'inline-block w-10 select-none border-r border-border/30 px-1.5 text-right tabular-nums',
          isAdd && 'bg-emerald-500/20 text-emerald-300/80',
          isDel && 'bg-red-500/15 text-red-300/60',
          line.kind === 'keep' && 'text-muted-foreground/40',
        )}
      >
        {line.newNo ?? ''}
      </span>
      <span
        className={cn(
          'inline-block w-5 select-none border-r border-border/30 text-center',
          isAdd && 'bg-emerald-500/20 text-emerald-300',
          isDel && 'bg-red-500/20 text-red-300',
          line.kind === 'keep' && 'text-muted-foreground/40',
        )}
      >
        {isAdd ? '+' : isDel ? '-' : ' '}
      </span>
      <span className="px-2">{line.text || ' '}</span>
    </div>
  );
}
