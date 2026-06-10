'use client';

import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ThinkingBlock } from '@/lib/types';
import Markdown from './Markdown';

export function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  const text = block.text.trim();
  if (!text && !block.streaming) return null;

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <Brain className="h-3 w-3 shrink-0 text-purple-400" />
        <span className="font-medium">Thinking</span>
        {block.streaming && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-purple-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400" />
            live
          </span>
        )}
      </button>
      {open && text && (
        <div className="mt-2 whitespace-pre-wrap border-l border-purple-400/30 pl-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground/90">
          {text}
        </div>
      )}
    </div>
  );
}

export function StreamingTextView({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (!text && !streaming) return null;
  return (
    <div className="text-sm leading-relaxed">
      {text &&
        (streaming ? (
          <div className="whitespace-pre-wrap">{text}</div>
        ) : (
          <Markdown>{text}</Markdown>
        ))}
      {streaming && (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-blink bg-foreground/60 align-baseline" />
      )}
    </div>
  );
}
