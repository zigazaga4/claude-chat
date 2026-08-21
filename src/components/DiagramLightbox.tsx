'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minus, Plus, X } from 'lucide-react';
import { namespaceSvgIds } from '@/lib/svgIds';

/**
 * Full-viewport view of an already-rendered diagram, with zoom and pan.
 *
 * Takes the SVG markup rather than the mermaid source: the diagram has already
 * been laid out by the time this can be opened, so re-rendering it would cost a
 * second layout pass to produce identical output.
 */

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
/** Small diagrams are scaled up to fill the screen, but only so far — past
 *  this they are all edge and no drawing. */
const MAX_FIT_SCALE = 4;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type View = { scale: number; x: number; y: number };

export default function DiagramLightbox({
  svg,
  title,
  onClose,
}: {
  svg: string;
  title?: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);

  // The inline copy stays mounted behind the overlay, so this one needs its own
  // id namespace or the two sets of `url(#…)` references cross over.
  const isolated = useMemo(() => namespaceSvgIds(svg, 'fs'), [svg]);

  /** Scale that makes the diagram fill the stage, centred and unpanned. */
  const fit = useCallback(() => {
    const stage = stageRef.current;
    const el = hostRef.current?.querySelector('svg');
    if (!stage || !el) return;

    const box = el.viewBox?.baseVal;
    let w = box?.width ?? 0;
    let h = box?.height ?? 0;
    if (!w || !h) {
      // No viewBox: fall back to the content's own bounds, which are available
      // regardless of how the element is laid out.
      try {
        const bb = el.getBBox();
        w = bb.width;
        h = bb.height;
      } catch {
        /* not rendered yet */
      }
    }
    if (!w || !h) return;

    // Mermaid ships width="100%" with NO height attribute. Once the inline
    // max-width is dropped there is nothing left for `auto` to resolve against
    // — an SVG with a viewBox has a ratio but no intrinsic size — and the
    // element collapses to 0×0 inside the centring flex box. Pin the natural
    // size here and let the transform do all the zooming.
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.maxWidth = 'none';

    const scale = clamp(
      Math.min((stage.clientWidth - 48) / w, (stage.clientHeight - 48) / h),
      MIN_SCALE,
      MAX_FIT_SCALE,
    );
    setView({ scale, x: 0, y: 0 });
  }, []);

  // Fit before paint so the diagram never flashes at the wrong size.
  useLayoutEffect(fit, [fit, isolated]);

  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fit]);

  // Keep the page behind from scrolling while the overlay owns the viewport.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key === '0') return fit();
      if (e.key === '+' || e.key === '=') {
        return setView((v) => ({ ...v, scale: clamp(v.scale * 1.2, MIN_SCALE, MAX_SCALE) }));
      }
      if (e.key === '-') {
        return setView((v) => ({ ...v, scale: clamp(v.scale / 1.2, MIN_SCALE, MAX_SCALE) }));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, fit]);

  // Wheel is bound natively because preventDefault() is required to stop the
  // page zooming underneath, and React's synthetic wheel listener is passive.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      // Cursor position relative to the stage centre, which is where the
      // untransformed diagram sits.
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      setView((v) => {
        const next = clamp(v.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        const k = next / v.scale;
        // Hold the point under the cursor still while the scale changes.
        return { scale: next, x: cx - k * (cx - v.x), y: cy - k * (cy - v.y) };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  /*
   * Every pointer currently down on the stage.
   *
   * One is a pan. Two is a pinch — the only way to zoom on a phone, where
   * there is no wheel and the toolbar's ± buttons cannot zoom about a point.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // Finger spread and midpoint at the previous pinch sample, so each move can
  // be applied as a ratio against the last one rather than the gesture start.
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  /** Spread and stage-relative midpoint of the first two live pointers. */
  const readPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const stage = stageRef.current;
    if (!a || !b || !stage) return null;
    const rect = stage.getBoundingClientRect();
    return {
      // Never zero — it divides the scale ratio.
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      cx: (a.x + b.x) / 2 - rect.left - rect.width / 2,
      cy: (a.y + b.y) / 2 - rect.top - rect.height / 2,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Only the left button for a mouse; touch and pen have no button to check.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      pinchRef.current = readPinch();
      dragRef.current = null;
    } else {
      dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const prev = pinchRef.current;
      const now = readPinch();
      if (!prev || !now) return;
      pinchRef.current = now;
      setView((v) => {
        const next = clamp(v.scale * (now.dist / prev.dist), MIN_SCALE, MAX_SCALE);
        const k = next / v.scale;
        // Pin the point between the fingers while the scale changes, and let
        // the new midpoint carry the diagram — so a two-finger gesture pans
        // and zooms at once, the way every map does.
        return { scale: next, x: now.cx - k * (prev.cx - v.x), y: now.cy - k * (prev.cy - v.y) };
      });
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (pointers.current.size >= 2) {
      pinchRef.current = readPinch();
      return;
    }
    pinchRef.current = null;
    // Lifting one finger of a pinch hands the gesture to the one still down,
    // rather than freezing until everything is released and re-pressed.
    const [id] = [...pointers.current.keys()];
    const rest = id === undefined ? null : pointers.current.get(id);
    dragRef.current = rest && id !== undefined ? { id, x: rest.x, y: rest.y } : null;
  };

  const zoom = (factor: number) =>
    setView((v) => ({ ...v, scale: clamp(v.scale * factor, MIN_SCALE, MAX_SCALE) }));

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm" role="dialog" aria-modal aria-label={title ?? 'Diagram'}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
          {title ?? 'Diagram'}
        </span>
        <button
          type="button"
          onClick={() => zoom(1 / 1.2)}
          title="Zoom out (−)"
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-11 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoom(1.2)}
          title="Zoom in (+)"
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={fit}
          title="Fit to screen (0)"
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
        // `touch-none` is what makes any of this work on a phone: without it
        // the browser claims the gesture for its own scroll/zoom and fires
        // pointercancel, so dragging the diagram does nothing at all.
        className="relative flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            ref={hostRef}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transformOrigin: 'center',
            }}
            dangerouslySetInnerHTML={{ __html: isolated }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
