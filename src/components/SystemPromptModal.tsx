'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, ScrollText, X } from 'lucide-react';
import { cn } from '@/lib/cn';

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Editor for the operator system prompt. Loads the current prompt from
 * /api/system-prompt on open, saves with PUT. Changes apply to the next
 * chat session — no server restart needed.
 */
export default function SystemPromptModal({ open, onClose }: Props) {
  // Gate by mounting: each open mounts a fresh editor, so loading/saved/
  // error reset through initial state instead of setState calls in effects.
  if (!open) return null;
  return <SystemPromptEditor onClose={onClose} />;
}

function SystemPromptEditor({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [filePath, setFilePath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system-prompt')
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load the system prompt');
        const data = (await res.json()) as { prompt: string; path: string };
        if (cancelled) return;
        setText(data.prompt);
        setFilePath(data.path);
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

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch('/api/system-prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Save failed');
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Portal to <body>: ancestors with backdrop-filter (e.g. the top bar)
  // become containing blocks for `fixed` descendants and would trap the
  // overlay inside their box.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ScrollText className="h-4 w-4 text-primary" />
            <span>System prompt</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            Prepended to every new chat session&apos;s system prompt. Leave
            empty to run with no operator prompt. Changes apply to the next
            message — no restart needed.
          </p>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading current prompt...
            </div>
          ) : (
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(false);
              }}
              spellCheck={false}
              placeholder="You are..."
              className="scrollbar-thin h-72 min-h-0 w-full flex-1 resize-none rounded-lg border border-border/60 bg-background/60 p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-primary/50"
            />
          )}
          {filePath && (
            <div className="truncate text-[10.5px] text-muted-foreground/70" title={filePath}>
              Stored in {filePath}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 px-4 py-3">
          {saved && (
            <span className="mr-auto inline-flex items-center gap-1 text-[11.5px] text-emerald-300">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/25',
              (saving || loading) && 'cursor-not-allowed opacity-50',
            )}
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
