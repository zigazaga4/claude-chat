'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name, also shown as the panel's heading. */
  title: string;
  children: ReactNode;
  /** Width of the panel. Capped at the viewport so it can never overflow. */
  className?: string;
};

/**
 * A slide-over panel, portalled to <body>.
 *
 * Exists because the left sidebar is `hidden md:block`, which on a phone means
 * every route to picking a folder, a workspace, or a conversation simply does
 * not render. This is the mobile home for that panel; the desktop layout still
 * shows it inline and never opens this.
 *
 * Dismissal is deliberately over-provided — backdrop tap, close button,
 * Escape, and a horizontal swipe — because it covers the whole screen on a
 * phone and being stuck inside it would be worse than not having it.
 */
export default function Drawer({ open, onClose, title, children, className }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Swipe-to-dismiss bookkeeping. A ref, not state: this updates on every
  // pointermove and must not re-render the panel mid-gesture.
  const drag = useRef<{ startX: number; dx: number; active: boolean }>({
    startX: 0,
    dx: 0,
    active: false,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Guard the portal target rather than tracking mount in state — the same
  // check the other portalled dialogs here use. Nothing renders on the server,
  // and `open` is false on the first client render, so there is no mismatch.
  if (typeof document === 'undefined' || !open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    // Only follow direct touch drags; a mouse in this panel is scrolling a
    // list, and pointer capture would swallow those clicks.
    if (e.pointerType === 'mouse') return;
    drag.current = { startX: e.clientX, dx: 0, active: true };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active || !panelRef.current) return;
    // Rightward drags do nothing — the panel is already flush against the
    // left edge and there is nowhere for it to go.
    const dx = Math.min(0, e.clientX - drag.current.startX);
    drag.current.dx = dx;
    panelRef.current.style.transform = `translateX(${dx}px)`;
    panelRef.current.style.transition = 'none';
  };

  const endDrag = () => {
    if (!drag.current.active || !panelRef.current) return;
    const { dx } = drag.current;
    drag.current.active = false;
    const width = panelRef.current.offsetWidth || 1;
    panelRef.current.style.transform = '';
    panelRef.current.style.transition = '';
    // A third of the way across is enough intent to dismiss.
    if (dx < -width / 3) onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="tap-auto absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          'absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-border/70 bg-card shadow-2xl',
          'animate-drawer-in pb-safe pl-safe pt-safe',
          className,
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-2">
          <span className="text-xs font-semibold tracking-tight text-foreground">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
