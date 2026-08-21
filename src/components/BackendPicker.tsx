'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Cpu, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { placeMenuAbove, type MenuCoords } from '@/lib/anchorMenu';
import { BACKENDS, getBackendInfo, type ChatBackend } from '@/lib/backends';

/** Matches the `w-[300px]` below — used to place the menu before it exists. */
const PREFERRED_WIDTH = 300;

const STYLES: Record<ChatBackend, { btn: string; dot: string }> = {
  sdk: {
    btn: 'border-orange-500/40 bg-orange-500/10 text-orange-200 hover:bg-orange-500/15',
    dot: 'bg-orange-400',
  },
  opencode: {
    btn: 'border-slate-400/40 bg-slate-400/10 text-slate-200 hover:bg-slate-400/15',
    dot: 'bg-slate-300',
  },
};

type Props = {
  backend: ChatBackend;
  onChange: (backend: ChatBackend) => void;
  /**
   * The conversation already exists, so the engine is fixed. Rendered as a
   * read-only badge — see `@/lib/backends` for why this can never be changed
   * after the first turn.
   */
  locked?: boolean;
  disabled?: boolean;
};

export default function BackendPicker({
  backend,
  onChange,
  locked,
  disabled,
}: Props) {
  const info = getBackendInfo(backend);
  const s = STYLES[backend];
  const [open, setOpen] = useState(false);
  // Same portalled, upward-opening placement as the model picker: the composer
  // clips overflow, so an in-flow popover would be cut off.
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    setCoords(placeMenuAbove(el, menuRef.current?.offsetWidth || PREFERRED_WIDTH));
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Second pass once the menu is actually in the DOM, so the clamp works
    // off its real width instead of the estimate. Converges immediately —
    // the re-placed menu measures the same on the next call.
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open]);

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

  const select = (id: ChatBackend) => {
    onChange(id);
    setOpen(false);
  };

  const title = locked
    ? `Engine: ${info.label} — fixed for this conversation. Start a new chat to use the other one.`
    : `Engine: ${info.label} — click to choose. Locks once this conversation starts.`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !locked && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup={locked ? undefined : 'listbox'}
        aria-expanded={locked ? undefined : open}
        title={title}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
          'disabled:cursor-not-allowed disabled:opacity-50',
          locked && 'cursor-default',
          s.btn,
        )}
      >
        <Cpu className="h-3.5 w-3.5" />
        <span className="whitespace-nowrap">{info.shortLabel}</span>
        <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
        {locked ? (
          <Lock className="h-3 w-3 opacity-60" />
        ) : (
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
      {open &&
        !locked &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{ left: coords.left, bottom: coords.bottom, maxWidth: coords.maxWidth }}
            className="fixed z-50 w-[300px] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-1 shadow-lg shadow-black/30 backdrop-blur-sm"
          >
            {BACKENDS.map((b) => {
              const bs = STYLES[b.id];
              const selected = b.id === backend;
              return (
                <button
                  key={b.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => select(b.id)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors',
                    selected
                      ? 'bg-muted/70 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', bs.dot)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{b.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug opacity-70">
                      {b.description}
                    </span>
                  </span>
                  {selected && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })}
            <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground/70">
              Fixed once this conversation starts — each engine stores its
              sessions separately.
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
