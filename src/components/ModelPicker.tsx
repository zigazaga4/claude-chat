'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MODELS, getModelInfo, type ModelId } from '@/lib/models';

const STYLES: Record<ModelId, { btn: string; dot: string }> = {
  'claude-fable-5': {
    btn: 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15',
    dot: 'bg-amber-400',
  },
  'claude-opus-4-8': {
    btn: 'border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15',
    dot: 'bg-violet-400',
  },
  'claude-opus-4-7': {
    btn: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/15',
    dot: 'bg-indigo-400',
  },
  'claude-sonnet-4-6': {
    btn: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15',
    dot: 'bg-cyan-400',
  },
  'claude-haiku-4-5': {
    btn: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15',
    dot: 'bg-emerald-400',
  },
};

type Props = {
  model: ModelId;
  onChange: (model: ModelId) => void;
  disabled?: boolean;
};

export default function ModelPicker({ model, onChange, disabled }: Props) {
  const info = getModelInfo(model);
  const s = STYLES[info.id];
  const [open, setOpen] = useState(false);
  // Fixed-position anchor for the portalled menu: it opens UPWARD from the
  // trigger (the composer sits at the bottom of the screen), so we pin its
  // bottom edge just above the button. A portal is required because the
  // composer root clips overflow — an in-flow popover would be cut off.
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ left: r.left, bottom: window.innerHeight - r.top + 6 });
  };

  // Measure synchronously before paint so the menu never flashes at (0,0).
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // Keep the menu glued to the trigger while open, and close on outside
  // click / Escape. Reposition on scroll/resize rather than chase layout.
  useEffect(() => {
    if (!open) return;
    const onReflow = () => place();
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (id: ModelId) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Model: ${info.label} — click to choose`}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
          'disabled:cursor-not-allowed disabled:opacity-50',
          s.btn,
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="whitespace-nowrap">{info.shortLabel}</span>
        <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{ left: coords.left, bottom: coords.bottom }}
            className="fixed z-50 min-w-[200px] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg shadow-black/30 backdrop-blur-sm"
          >
            {MODELS.map((m) => {
              const ms = STYLES[m.id];
              const selected = m.id === model;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => select(m.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                    selected
                      ? 'bg-muted/70 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', ms.dot)} />
                  <span className="flex-1 whitespace-nowrap font-medium">
                    {m.label}
                  </span>
                  {selected && (
                    <Check className="h-3.5 w-3.5 text-foreground/80" />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
