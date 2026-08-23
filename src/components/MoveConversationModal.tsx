'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, Globe, Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { isSshCwd, shortLabel } from '@/lib/cwd';
import { moveConversation } from '@/lib/conversationApi';

type Workspace = {
  cwd: string;
  kind: 'local' | 'ssh';
  conversationCount: number;
};

type Props = {
  open: boolean;
  conversationId: string;
  /** Workspace the conversation is in now — excluded from the destinations. */
  fromCwd: string;
  /** Human label for the header (title or short id). */
  label: string;
  onClose: () => void;
  /**
   * Fired after a successful move, with the destination. The parent owns the
   * lists this invalidates, so it does the refreshing — this component knows
   * only that the move happened.
   */
  onMoved: (toCwd: string) => void;
};

/**
 * Move one conversation into another workspace.
 *
 * Destinations are the workspaces cloudchat already knows, local and remote
 * alike, because a conversation is bound to a folder by its path alone and any
 * folder in the sidebar is a legitimate home for it. That also matches what the
 * server will accept: it refuses a destination it has no workspace row for,
 * since it cannot tell whether an unknown `ssh://` path wants a password, a key
 * or an agent, and inventing a local folder for it would be worse than saying
 * no.
 */
export default function MoveConversationModal({
  open,
  conversationId,
  fromCwd,
  label,
  onClose,
  onMoved,
}: Props) {
  // Mount-gate, matching the other modals here: each open starts from fresh
  // state rather than resetting it in an effect.
  if (!open) return null;
  return (
    <MovePicker
      conversationId={conversationId}
      fromCwd={fromCwd}
      label={label}
      onClose={onClose}
      onMoved={onMoved}
    />
  );
}

function MovePicker({
  conversationId,
  fromCwd,
  label,
  onClose,
  onMoved,
}: Omit<Props, 'open'>) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load your folders');
        const data = (await res.json()) as { workspaces: Workspace[] };
        if (cancelled) return;
        setWorkspaces(data.workspaces ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Load failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never close out from under an in-flight move: the request is still
      // going to land, and dismissing the window is a fair way to believe it
      // did not.
      if (e.key === 'Escape' && !moving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, moving]);

  const { local, remote, total } = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const candidates = workspaces.filter((w) => {
      if (w.cwd === fromCwd) return false;
      if (!needle) return true;
      // Match the path and the label the sidebar shows, so typing what you see
      // works as well as typing what it is.
      return (
        w.cwd.toLowerCase().includes(needle) ||
        shortLabel(w.cwd).toLowerCase().includes(needle)
      );
    });
    return {
      local: candidates.filter((w) => w.kind !== 'ssh' && !isSshCwd(w.cwd)),
      remote: candidates.filter((w) => w.kind === 'ssh' || isSshCwd(w.cwd)),
      total: candidates.length,
    };
  }, [workspaces, fromCwd, filter]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setMoving(true);
    setError(null);
    try {
      await moveConversation(conversationId, selected, fromCwd);
      onMoved(selected);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The move failed.');
      setMoving(false);
    }
  }, [selected, conversationId, fromCwd, onMoved, onClose]);

  const groups: { title: string; rows: Workspace[] }[] = [
    { title: 'Local folders', rows: local },
    { title: 'Remote folders', rows: remote },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={() => {
          if (!moving) onClose();
        }}
        aria-hidden="true"
      />
      <div className="relative flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <FolderInput className="h-4 w-4 shrink-0 text-primary" />
            <span className="shrink-0">Move conversation</span>
            <span
              className="truncate text-[11px] font-normal text-muted-foreground"
              title={label}
            >
              · {label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={moving}
            className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-4">
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            Pick where this conversation should live. Its whole history comes
            with it, and the next message runs in the new folder — with that
            folder&apos;s files, its MCP servers, and, for a remote folder, over
            that connection.
          </p>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
            <span className="shrink-0">Currently in</span>
            <span
              className="truncate rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[10.5px]"
              title={fromCwd}
            >
              {fromCwd}
            </span>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              placeholder="Filter folders…"
              className="w-full rounded-md border border-input bg-background py-1 pl-7 pr-2 text-xs outline-none focus:border-ring"
            />
          </div>

          <div className="scrollbar-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading folders...
              </div>
            ) : total === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                {workspaces.length <= 1
                  ? 'There is nowhere else to move this yet — add another folder first.'
                  : 'No folder matches that filter.'}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((group) =>
                  group.rows.length === 0 ? null : (
                    <div key={group.title} className="flex flex-col gap-1">
                      <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                        {group.title}
                      </div>
                      <ul className="flex flex-col gap-0.5">
                        {group.rows.map((w) => {
                          const isSsh = w.kind === 'ssh' || isSshCwd(w.cwd);
                          const isPicked = selected === w.cwd;
                          return (
                            <li key={w.cwd}>
                              <button
                                type="button"
                                onClick={() => setSelected(w.cwd)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
                                  isPicked
                                    ? isSsh
                                      ? 'border-emerald-400/60 bg-emerald-500/10'
                                      : 'border-blue-400/60 bg-blue-500/10'
                                    : 'border-transparent hover:bg-secondary',
                                )}
                              >
                                {isSsh ? (
                                  <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                                ) : (
                                  <FolderInput className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                                )}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[12px] leading-tight">
                                    {shortLabel(w.cwd)}
                                  </span>
                                  <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                                    {w.cwd}
                                  </span>
                                </span>
                                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                                  {w.conversationCount}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={moving}
            className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!selected || moving}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/25',
              (!selected || moving) && 'cursor-not-allowed opacity-50',
            )}
          >
            {moving && <Loader2 className="h-3 w-3 animate-spin" />}
            {selected ? `Move to ${shortLabel(selected)}` : 'Move'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
