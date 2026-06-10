'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquarePlus, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ChatMessage } from '@/lib/types';
import { useInstances } from '@/state/instances';

type ConversationRow = {
  id: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  source: 'claude-chat' | 'sdk';
  origin?: 'local' | 'ssh';
};

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export default function ConversationPicker() {
  const { active, openConversation, openNewConversation } = useInstances();
  const cwd = active.cwd;
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `request failed (${res.status})`);
      }
      const data = (await res.json()) as { conversations: ConversationRow[] };
      setRows(data.conversations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const onPick = async (row: ConversationRow) => {
    if (!cwd) return;
    setOpeningId(row.id);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(row.id)}/messages?cwd=${encodeURIComponent(cwd)}`,
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `request failed (${res.status})`);
      }
      const data = (await res.json()) as {
        messages: ChatMessage[];
        oldestSeq: number | null;
        hasMoreOlder: boolean;
      };
      openConversation(active.id, row.id, {
        messages: data.messages,
        oldestSeq: data.oldestSeq,
        hasMoreOlder: data.hasMoreOlder,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open conversation');
      setOpeningId(null);
    }
  };

  const onNew = () => {
    openNewConversation(active.id);
  };

  if (!cwd) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-8">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold tracking-tight">Conversations</div>
          <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
            {cwd}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      <button
        type="button"
        onClick={onNew}
        className="group/new flex items-center gap-3 rounded-2xl border border-blue-400/40 bg-gradient-to-r from-blue-500/15 via-blue-500/[0.08] to-transparent px-4 py-3 text-left shadow-[0_0_24px_-10px_rgba(80,150,255,0.6)] transition-all duration-200 hover:border-blue-400/70 hover:shadow-[0_0_32px_-6px_rgba(80,150,255,0.8)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600 text-white shadow-md">
          <MessageSquarePlus className="h-4 w-4" />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-semibold tracking-tight">New conversation</span>
          <span className="text-[11px] text-muted-foreground">
            Start a fresh chat in this folder
          </span>
        </span>
        <Sparkles className="ml-auto h-3.5 w-3.5 text-blue-400/80 transition-opacity group-hover/new:opacity-100" />
      </button>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          Loading conversations...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
          No conversations yet for this folder. Start a new one above.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const isOpening = openingId === row.id;
            const label = row.title ?? `Conversation ${shortId(row.id)}`;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => void onPick(row)}
                  disabled={isOpening}
                  className="group/row flex w-full items-center gap-3 rounded-xl border border-border/50 bg-card/40 px-3 py-2.5 text-left transition-colors hover:border-blue-400/40 hover:bg-card/70 disabled:opacity-60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{label}</span>
                      {row.source === 'sdk' && (
                        <span className="shrink-0 rounded border border-border/60 bg-muted/40 px-1.5 py-0 text-[9px] uppercase tracking-wide text-muted-foreground">
                          external
                        </span>
                      )}
                      {row.origin === 'ssh' && (
                        <span className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0 text-[9px] uppercase tracking-wide text-primary">
                          ssh
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-mono">{shortId(row.id)}</span>
                      <span className="opacity-50">•</span>
                      <span>{formatRelative(row.updatedAt)}</span>
                      {row.messageCount > 0 && (
                        <>
                          <span className="opacity-50">•</span>
                          <span>
                            {row.messageCount} message{row.messageCount === 1 ? '' : 's'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {isOpening ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-400" />
                  ) : (
                    <span className="shrink-0 text-[11px] font-medium text-muted-foreground transition-colors group-hover/row:text-blue-400">
                      Open →
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
