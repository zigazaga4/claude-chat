'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Check,
  Folder,
  FolderPlus,
  Globe,
  Home,
  Loader2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';

type BrowseResult = {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string }[];
  error?: string;
};

type Props = {
  /** Any existing workspace cwd on the target host (we lift creds from it). */
  anchorCwd: string;
  /** "user@host:port" for the modal title. */
  hostLabel: string;
  onClose: () => void;
  onAdded: (newWorkspaceCwd: string) => void;
};

export default function RemoteFolderPicker({
  anchorCwd,
  hostLabel,
  onClose,
  onAdded,
}: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);

  const browse = useCallback(
    async (target: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ cwd: anchorCwd });
        if (target) params.set('path', target);
        const res = await fetch(`/api/ssh/browse?${params.toString()}`);
        const json = (await res.json()) as BrowseResult;
        if (!res.ok) {
          setError(json.error || `HTTP ${res.status}`);
          return;
        }
        setData(json);
        setPath(json.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Browse failed');
      } finally {
        setLoading(false);
      }
    },
    [anchorCwd],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void browse(null);
  }, [browse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onCreate = async () => {
    const name = newName.trim();
    if (!name || !data?.path) return;
    setCreatingBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ssh/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: anchorCwd, parent: data.path, name }),
      });
      const json = (await res.json()) as { ok?: boolean; path?: string; error?: string };
      if (!res.ok || !json.path) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setNewName('');
      setCreating(false);
      // Re-list the parent so the new folder shows up; the user can then
      // click into it before confirming.
      await browse(data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setCreatingBusy(false);
    }
  };

  const onAdd = async () => {
    if (!data?.path) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/ssh/add-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchorCwd, newPath: data.path }),
      });
      const json = (await res.json()) as { ok?: boolean; cwd?: string; error?: string };
      if (!res.ok || !json.cwd) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      onAdded(json.cwd);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed');
    } finally {
      setAdding(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Globe className="h-4 w-4 text-emerald-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-tight">Add folder</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {hostLabel}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={() => data?.parent && browse(data.parent)}
            disabled={!data?.parent || loading}
            className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"
            aria-label="Up"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => data && browse(data.home)}
            disabled={loading}
            className="rounded p-1 text-muted-foreground hover:bg-secondary"
            aria-label="Home"
          >
            <Home className="h-4 w-4" />
          </button>
          <input
            type="text"
            value={path ?? ''}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path) browse(path);
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
            placeholder="/absolute/path"
          />
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setNewName('');
            }}
            disabled={!data?.path || loading}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
            title={data?.path ? `Create folder under ${data.path}` : 'Create folder'}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New
          </button>
        </div>
        {creating && (
          <div className="flex items-center gap-2 border-b border-border bg-emerald-500/[0.04] px-3 py-2">
            <FolderPlus className="h-4 w-4 shrink-0 text-emerald-400" />
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewName('');
                }
              }}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
              placeholder="folder-name"
            />
            <button
              type="button"
              onClick={() => void onCreate()}
              disabled={!newName.trim() || creatingBusy}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/80 px-2 py-1 text-[11px] font-semibold text-emerald-50 hover:bg-emerald-500 disabled:opacity-40"
              aria-label="Create"
            >
              {creatingBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewName('');
              }}
              disabled={creatingBusy}
              className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-40"
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="scrollbar-thin h-72 overflow-y-auto bg-card">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-destructive">
              <div>{error}</div>
              <button
                type="button"
                onClick={() => browse(path)}
                className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-secondary"
              >
                Retry
              </button>
            </div>
          ) : !data || data.entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Empty directory
            </div>
          ) : (
            <ul>
              {data.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => browse(e.path)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary',
                    )}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!data?.path || adding}
            onClick={() => void onAdd()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {adding && <Loader2 className="h-3 w-3 animate-spin" />}
            Add this folder
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
