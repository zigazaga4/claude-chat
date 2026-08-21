'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { placeMenuAbove, type MenuCoords } from '@/lib/anchorMenu';
import { MODELS, getModelInfo, type ModelId } from '@/lib/models';

/** Opening estimate only — this menu's real width comes from its labels. */
const PREFERRED_WIDTH = 240;
import {
  DEFAULT_BACKEND,
  modelsForBackend,
  type ChatBackend,
} from '@/lib/backends';

const STYLES: Record<ModelId, { btn: string; dot: string }> = {
  'claude-fable-5': {
    btn: 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15',
    dot: 'bg-amber-400',
  },
  'claude-opus-5': {
    btn: 'border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/15',
    dot: 'bg-purple-400',
  },
  'claude-sonnet-5': {
    btn: 'border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/15',
    dot: 'bg-sky-400',
  },
  'deepseek-v4-pro': {
    btn: 'border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/15',
    dot: 'bg-blue-400',
  },
  'deepseek-v4-flash': {
    btn: 'border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15',
    dot: 'bg-teal-400',
  },
  'moonshotai/kimi-k3': {
    btn: 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15',
    dot: 'bg-rose-400',
  },
  // Same model as above, subscription-billed — kept in the rose family so the
  // two Kimi entries read as siblings rather than unrelated models.
  'kimi-k3-code': {
    btn: 'border-pink-500/40 bg-pink-500/10 text-pink-200 hover:bg-pink-500/15',
    dot: 'bg-pink-400',
  },
  'glm-5.3': {
    btn: 'border-lime-500/40 bg-lime-500/10 text-lime-200 hover:bg-lime-500/15',
    dot: 'bg-lime-400',
  },
  'qwen3.8-max': {
    btn: 'border-orange-500/40 bg-orange-500/10 text-orange-200 hover:bg-orange-500/15',
    dot: 'bg-orange-400',
  },
};

type Props = {
  model: ModelId;
  onChange: (model: ModelId) => void;
  disabled?: boolean;
  /**
   * Engine this conversation runs on. Models it cannot serve are hidden rather
   * than shown-and-rejected — OpenCode cannot run Claude, and offering a
   * choice the server will refuse is worse than not offering it.
   */
  backend?: ChatBackend;
};

export default function ModelPicker({
  model,
  onChange,
  disabled,
  backend = DEFAULT_BACKEND,
}: Props) {
  const available = modelsForBackend(MODELS, backend);
  const info = getModelInfo(model);
  const s = STYLES[info.id];
  const [open, setOpen] = useState(false);
  // Fixed-position anchor for the portalled menu: it opens UPWARD from the
  // trigger (the composer sits at the bottom of the screen), so we pin its
  // bottom edge just above the button. A portal is required because the
  // composer root clips overflow — an in-flow popover would be cut off.
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    setCoords(placeMenuAbove(el, menuRef.current?.offsetWidth || PREFERRED_WIDTH));
  };

  // Measure synchronously before paint so the menu never flashes at (0,0).
  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Second pass once the menu is in the DOM — this one's width is driven by
    // its longest label, so the estimate above is only a starting point.
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Keep the menu glued to the trigger while open, and close on outside
  // click / Escape. Reposition on scroll/resize rather than chase layout.
  useEffect(() => {
    if (!open) return;
    const onReflow = () => place();
    const onPointerDown = (e: PointerEvent) => {
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
    // The software keyboard shrinks the visual viewport without firing a
    // window resize, so without these the menu stays where the pre-keyboard
    // layout put it — usually behind the keyboard.
    window.visualViewport?.addEventListener('resize', onReflow);
    window.visualViewport?.addEventListener('scroll', onReflow);
    // `pointerdown` rather than `mousedown`: touch browsers synthesise mouse
    // events late, and in some cases not at all.
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
      window.visualViewport?.removeEventListener('resize', onReflow);
      window.visualViewport?.removeEventListener('scroll', onReflow);
      document.removeEventListener('pointerdown', onPointerDown);
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
            style={{ left: coords.left, bottom: coords.bottom, maxWidth: coords.maxWidth }}
            className="fixed z-50 min-w-[200px] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg shadow-black/30 backdrop-blur-sm"
          >
            {available.map((m) => {
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
