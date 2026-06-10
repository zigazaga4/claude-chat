'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Folder, Home, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

type Entry = { name: string; path: string };
type BrowseResult = {
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
  error?: string;
};

type FolderPickerProps = {
  open: boolean;
  initialPath?: string | null;
  onClose: () => void;
  onSelect: (absPath: string) => void;
};

export default function FolderPicker({ open, initialPath, onClose, onSelect }: FolderPickerProps) {
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const url = p ? `/api/fs/browse?path=${encodeURIComponent(p)}` : '/api/fs/browse';
      const res = await fetch(url);
      const json: BrowseResult = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to load directory');
        return;
      }
      setData(json);
      setPath(json.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(initialPath ?? null);
  }, [open, initialPath, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal>
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={() => data?.parent && load(data.parent)}
            disabled={!data?.parent || loading}
            className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"
            aria-label="Up"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => data && load(data.home)}
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
              if (e.key === 'Enter') void load(path);
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
            placeholder="/absolute/path"
          />
        </div>
        <div className="scrollbar-thin h-80 overflow-y-auto bg-card">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
              {error}
            </div>
          ) : data && data.entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Empty directory
            </div>
          ) : (
            <ul>
              {data?.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onDoubleClick={() => load(e.path)}
                    onClick={() => load(e.path)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                      'hover:bg-secondary',
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
            className="rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!data?.path}
            onClick={() => {
              if (data?.path) {
                onSelect(data.path);
                onClose();
              }
            }}
            className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
