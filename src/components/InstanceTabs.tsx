'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Ghost, LogOut, Menu, Plus, ScrollText, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useInstances } from '@/state/instances';
import Logo from './Logo';
import SystemPromptModal from './SystemPromptModal';

function basename(p: string | null) {
  if (!p) return null;
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || '/';
}

/** Hold this long on a tab to pick it up, on touch. */
const LONG_PRESS_MS = 350;
/** Move further than this before the hold completes and it was a scroll. */
const MOVE_SLOP = 10;

export default function InstanceTabs({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const {
    instances,
    activeId,
    active,
    setActive,
    addInstance,
    removeInstance,
    reorderInstance,
    openNewConversation,
  } = useInstances();
  const [promptOpen, setPromptOpen] = useState(false);
  // Held in a ref as well as state: dragover fires many times a second and
  // reads this, and a ref is the value that is already current when it does.
  const draggingRef = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  /**
   * Move `heldId` so it lands at `overIndex`, on the side the pointer is on.
   *
   * Shared by the mouse and touch paths, which differ only in how they decide
   * a drag is happening — the index arithmetic is subtle enough that having
   * two copies of it would guarantee they drift apart.
   *
   * The swap commits only once the pointer passes the midpoint of the tab it
   * is over. Without that test the tab under the pointer moves out from under
   * it, which immediately satisfies the condition again in the other direction
   * and the two oscillate for as long as the pointer is held still.
   */
  const commitReorder = (heldId: string, overIndex: number, insertAfter: boolean) => {
    const slot = insertAfter ? overIndex + 1 : overIndex;
    // `slot` indexes the strip as it looks now; the reducer inserts after
    // pulling the dragged tab out, which shifts everything to its right down.
    const fromIndex = instances.findIndex((i) => i.id === heldId);
    if (fromIndex < 0) return;
    reorderInstance(heldId, fromIndex < slot ? slot - 1 : slot);
  };

  const onTabDragOver = (
    e: DragEvent<HTMLDivElement>,
    overId: string,
    overIndex: number,
  ) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const heldId = draggingRef.current;
    if (!heldId || heldId === overId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    commitReorder(heldId, overIndex, e.clientX > rect.left + rect.width / 2);
  };

  const endDrag = () => {
    draggingRef.current = null;
    setDraggingId(null);
  };

  /*
   * Touch reordering.
   *
   * HTML5 drag-and-drop emits nothing at all on a touchscreen, so the mouse
   * path above is dead weight on a phone. Long-press is the gesture people
   * already expect for "pick this up", and waiting for the hold is what keeps
   * it from stealing the horizontal swipe that scrolls the strip.
   */
  const touch = useRef<{
    id: string;
    x: number;
    y: number;
    timer: number | null;
    dragging: boolean;
  } | null>(null);
  // Set for the rest of the gesture once a drag happened, so releasing does
  // not also register as a tap and switch to the tab that was just moved.
  const suppressClick = useRef(false);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    // Must be a real listener with `passive: false` — React's onTouchMove is
    // registered passively, where preventDefault is ignored, and without it
    // the browser scrolls the strip out from under the finger mid-drag.
    const block = (e: TouchEvent) => {
      if (touch.current?.dragging) e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  const endTouch = () => {
    if (touch.current?.timer) window.clearTimeout(touch.current.timer);
    if (touch.current?.dragging) suppressClick.current = true;
    touch.current = null;
    endDrag();
  };

  const onTabTouchStart = (e: React.TouchEvent, id: string) => {
    const t = e.touches[0];
    const timer = window.setTimeout(() => {
      if (!touch.current) return;
      touch.current.dragging = true;
      draggingRef.current = id;
      setDraggingId(id);
      navigator.vibrate?.(10);
    }, LONG_PRESS_MS);
    touch.current = { id, x: t.clientX, y: t.clientY, timer, dragging: false };
  };

  const onTabTouchMove = (e: React.TouchEvent) => {
    const st = touch.current;
    if (!st) return;
    const t = e.touches[0];

    if (!st.dragging) {
      // Moved before the hold completed — this is a scroll, not a pick-up.
      if (Math.hypot(t.clientX - st.x, t.clientY - st.y) > MOVE_SLOP) endTouch();
      return;
    }

    // The finger is captured by the tab it started on, so the element under
    // the point is the only way to learn which tab it is now over.
    const over = document
      .elementFromPoint(t.clientX, t.clientY)
      ?.closest<HTMLElement>('[data-tab-index]');
    if (!over) return;
    const overIndex = Number(over.dataset.tabIndex);
    if (!Number.isInteger(overIndex)) return;
    const rect = over.getBoundingClientRect();
    commitReorder(st.id, overIndex, t.clientX > rect.left + rect.width / 2);
  };

  return (
    <div className="flex items-center gap-2 border-b border-border/70 bg-card/30 px-2.5 py-1.5 pt-[calc(0.375rem+env(safe-area-inset-top))] backdrop-blur-sm">
      {/* The only way into the sidebar on a phone, where it does not render
          inline. Hidden from `md` up, since there the panel is always there. */}
      <button
        type="button"
        onClick={onOpenMenu}
        className="-ml-1 shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
        aria-label="Open workspaces menu"
      >
        <Menu className="h-4 w-4" />
      </button>
      {/* The wordmark is the first thing worth dropping when space is tight. */}
      <Logo showWordmark={false} className="md:hidden" />
      <Logo className="hidden md:flex" />
      <div className="hidden h-5 w-px bg-border/60 sm:block" aria-hidden="true" />
      <div
        ref={stripRef}
        className="scrollbar-thin flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        // Accept the drag over the gaps between tabs too, so releasing there
        // finishes the reorder instead of showing a rejected-drop cursor.
        onDragOver={(e) => {
          if (draggingRef.current) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          endDrag();
        }}
      >
        {instances.map((inst, index) => {
          const active = inst.id === activeId;
          const label = basename(inst.cwd) ?? inst.name;
          return (
            <div
              key={inst.id}
              role="button"
              tabIndex={0}
              // Read back by the touch path via elementFromPoint, which only
              // gets a DOM node and has no way to ask React where it sits.
              data-tab-index={index}
              draggable
              onTouchStart={(e) => onTabTouchStart(e, inst.id)}
              onTouchMove={onTabTouchMove}
              onTouchEnd={endTouch}
              onTouchCancel={endTouch}
              onDragStart={(e) => {
                draggingRef.current = inst.id;
                setDraggingId(inst.id);
                e.dataTransfer.effectAllowed = 'move';
                // Firefox starts no drag at all unless some data is set.
                e.dataTransfer.setData('text/plain', inst.id);
              }}
              onDragOver={(e) => onTabDragOver(e, inst.id, index)}
              onDrop={(e) => {
                e.preventDefault();
                endDrag();
              }}
              onDragEnd={endDrag}
              onClick={() => {
                // The tap that ends a long-press reorder is not a selection.
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                setActive(inst.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActive(inst.id);
                }
              }}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-150',
                active
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                // The tab is already in its new slot while dragging, so the
                // ghost under the cursor is the only thing left to mark.
                draggingId === inst.id && 'opacity-50',
              )}
              title={inst.cwd ?? '(no folder selected)'}
            >
              <span className="max-w-[160px] truncate font-medium">{label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeInstance(inst.id);
                }}
                className={cn(
                  'rounded p-0.5 transition-opacity',
                  active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
                  // Without this the close button on an inactive tab is
                  // invisible on a touchscreen and there is no way to reveal
                  // it — hover never happens.
                  'touch:opacity-70',
                  'hover:bg-foreground/10',
                )}
                aria-label="Close instance"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addInstance}
        className="ml-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="New instance"
        title="New instance"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {/* Throwaway chat, one tap from anywhere. It used to live only behind a
          hover-revealed control inside the sidebar, which on a phone is inside
          a drawer — effectively unreachable, which is why the database had 168
          saved conversations and not one throwaway. */}
      <button
        type="button"
        onClick={() => openNewConversation(active.id, { ephemeral: true })}
        disabled={!active.cwd}
        className={cn(
          'shrink-0 rounded-md p-1 transition-colors',
          active.cwd
            ? 'text-amber-300/80 hover:bg-amber-500/15 hover:text-amber-200'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
        aria-label="New throwaway chat"
        title={
          active.cwd
            ? 'New throwaway chat — kept out of your saved conversations'
            : 'Pick a folder first'
        }
      >
        <Ghost className="h-3.5 w-3.5" />
      </button>
      <div className="h-5 w-px shrink-0 bg-border/60" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setPromptOpen(true)}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Edit system prompt"
        title="Edit system prompt"
      >
        <ScrollText className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={async () => {
          await fetch('/api/auth/logout', { method: 'POST' });
          // Full navigation, not a router push — the cleared cookie has to be
          // on a document request for the proxy to send us to /login.
          window.location.replace('/login');
        }}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Log out"
        title="Log out"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
      <SystemPromptModal open={promptOpen} onClose={() => setPromptOpen(false)} />
    </div>
  );
}
