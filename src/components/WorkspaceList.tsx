'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Globe,
  Loader2,
  LogOut,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Sparkles,
  Unplug,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { parseCwd, shortLabel } from '@/lib/cwd';
import type { ChatMessage } from '@/lib/types';
import { useInstances } from '@/state/instances';
import ConnectSshModal from './ConnectSshModal';
import FolderPicker from './FolderPicker';
import RemoteFolderPicker from './RemoteFolderPicker';

type WorkspaceRow = {
  cwd: string;
  firstUsed: number;
  lastUsed: number;
  conversationCount: number;
  lastConversation: { id: string; title: string | null; updatedAt: number } | null;
  kind: 'local' | 'ssh';
  sshIdentityPath: string | null;
  sshUseAgent: boolean;
  sshKnownHostFp: string | null;
  hasStoredPassword: boolean;
  sshConnected: boolean;
};

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

type Tab = 'local' | 'ssh';

type LoginPhase =
  | { kind: 'idle' }
  | { kind: 'auto' } // trying with stored password
  | { kind: 'prompt'; remember: boolean; password: string; error?: string }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string };

/**
 * Inputs to a single login attempt. Anything `undefined` means "leave the
 * saved value alone." `forgetPassword: true` clears the stored password and
 * forces the server to skip it on this attempt — the escape hatch when a
 * stale remembered password is shadowing key/agent auth. `tryAuto: true`
 * goes further: it ignores every saved knob and lets the server auto-discover
 * SSH agent + default keys, matching what the system `ssh` command does.
 */
type LoginAttempt = {
  password?: string;
  remember?: boolean;
  identityPath?: string | null;
  useAgent?: boolean;
  forgetPassword?: boolean;
  tryAuto?: boolean;
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

function pathTail(p: string): string {
  const trimmed = p.replace(/\/$/, '');
  if (trimmed === '' || trimmed === '/') return '/';
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}

type SshHostGroup = {
  key: string; // user@host:port
  user: string;
  host: string;
  port: number;
  workspaces: WorkspaceRow[];
  /** True if any workspace under this host shows a live SSH connection. */
  connected: boolean;
  /** True if any workspace under this host has a remembered password. */
  hasStoredPassword: boolean;
  /** Most recent activity across all paths on this host. */
  lastUsed: number;
};

function groupSshByHost(rows: WorkspaceRow[]): SshHostGroup[] {
  const map = new Map<string, SshHostGroup>();
  for (const w of rows) {
    if (w.kind !== 'ssh') continue;
    let parsed;
    try {
      parsed = parseCwd(w.cwd);
    } catch {
      continue;
    }
    if (parsed.kind !== 'ssh') continue;
    const key = `${parsed.user}@${parsed.host}:${parsed.port}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        user: parsed.user,
        host: parsed.host,
        port: parsed.port,
        workspaces: [],
        connected: false,
        hasStoredPassword: false,
        lastUsed: 0,
      };
      map.set(key, g);
    }
    g.workspaces.push(w);
    g.connected = g.connected || w.sshConnected;
    g.hasStoredPassword = g.hasStoredPassword || w.hasStoredPassword;
    if (w.lastUsed > g.lastUsed) g.lastUsed = w.lastUsed;
  }
  for (const g of map.values()) {
    g.workspaces.sort((a, b) => b.lastUsed - a.lastUsed);
  }
  return Array.from(map.values()).sort((a, b) => b.lastUsed - a.lastUsed);
}

export default function WorkspaceList() {
  const { active, patch, openConversation, openNewConversation } = useInstances();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('local');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(() => new Set());
  const [addFolderHost, setAddFolderHost] = useState<SshHostGroup | null>(null);
  const [convsByCwd, setConvsByCwd] = useState<Record<string, ConversationRow[]>>({});
  const [convsLoading, setConvsLoading] = useState<Record<string, boolean>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [loginByCwd, setLoginByCwd] = useState<Record<string, LoginPhase>>({});
  const fetchedCwdsRef = useRef<Set<string>>(new Set());
  const autoLoginAttemptedRef = useRef<Set<string>>(new Set());

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { workspaces: WorkspaceRow[] };
      setWorkspaces(data.workspaces);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConversations = useCallback(async (cwd: string) => {
    setConvsLoading((p) => ({ ...p, [cwd]: true }));
    try {
      const res = await fetch(`/api/conversations?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { conversations: ConversationRow[] };
      setConvsByCwd((prev) => ({ ...prev, [cwd]: data.conversations }));
    } catch {
      setConvsByCwd((prev) => ({ ...prev, [cwd]: [] }));
    } finally {
      setConvsLoading((p) => ({ ...p, [cwd]: false }));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const ensureConvsLoaded = useCallback(
    (cwd: string) => {
      if (fetchedCwdsRef.current.has(cwd)) return;
      fetchedCwdsRef.current.add(cwd);
      void loadConversations(cwd);
    },
    [loadConversations],
  );

  // ---- Auth flow for SSH rows ---------------------------------------------

  const setLogin = (cwd: string, phase: LoginPhase) =>
    setLoginByCwd((prev) => ({ ...prev, [cwd]: phase }));

  const tryLogin = useCallback(
    async (cwd: string, attempt: LoginAttempt = {}) => {
      const isExplicit =
        attempt.password !== undefined ||
        attempt.identityPath !== undefined ||
        attempt.useAgent !== undefined ||
        !!attempt.forgetPassword ||
        !!attempt.tryAuto;
      setLogin(cwd, isExplicit ? { kind: 'submitting' } : { kind: 'auto' });
      try {
        const res = await fetch('/api/ssh/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cwd,
            password: attempt.password,
            rememberPassword: attempt.remember,
            identityPath: attempt.identityPath,
            useAgent: attempt.useAgent,
            forgetPassword: attempt.forgetPassword,
            tryAuto: attempt.tryAuto,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          needsPassword?: boolean;
        };
        if (data.ok) {
          setLogin(cwd, { kind: 'idle' });
          await loadWorkspaces(); // refresh `sshConnected` + identity/agent
          return true;
        }
        if (data.needsPassword) {
          setLogin(cwd, {
            kind: 'prompt',
            remember: !!attempt.remember,
            password: '',
            error: undefined,
          });
        } else {
          setLogin(cwd, {
            kind: 'prompt',
            remember: !!attempt.remember,
            password: attempt.password ?? '',
            error: data.error || 'Login failed',
          });
        }
        return false;
      } catch (e) {
        setLogin(cwd, {
          kind: 'error',
          message: e instanceof Error ? e.message : 'Network error',
        });
        return false;
      }
    },
    [loadWorkspaces],
  );

  const expand = (cwd: string) => {
    setExpanded((prev) => {
      if (prev.has(cwd)) return prev;
      const next = new Set(prev);
      next.add(cwd);
      return next;
    });
    ensureConvsLoaded(cwd);
  };

  const collapse = (cwd: string) => {
    setExpanded((prev) => {
      if (!prev.has(cwd)) return prev;
      const next = new Set(prev);
      next.delete(cwd);
      return next;
    });
  };

  const onWorkspaceClick = (w: WorkspaceRow) => {
    if (expanded.has(w.cwd)) {
      collapse(w.cwd);
      return;
    }
    if (w.kind === 'ssh' && !w.sshConnected) {
      // Fire one silent attempt on first expand. If a password is on file we
      // try that (auth method the user already chose). Otherwise we hand it
      // to auto-discovery — SSH_AUTH_SOCK + default ~/.ssh keys — instead of
      // asking the user for a password they don't need.
      expand(w.cwd);
      if (
        !autoLoginAttemptedRef.current.has(w.cwd) &&
        loginByCwd[w.cwd]?.kind !== 'submitting'
      ) {
        autoLoginAttemptedRef.current.add(w.cwd);
        if (w.hasStoredPassword) {
          void tryLogin(w.cwd);
        } else {
          void tryLogin(w.cwd, { tryAuto: true });
        }
      }
      return;
    }
    expand(w.cwd);
  };

  // ---- Workspace actions ---------------------------------------------------

  const onAddFolder = async (p: string) => {
    try {
      await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: p }),
      });
    } catch {
      /* ignore */
    }
    patch(active.id, {
      cwd: p,
      view: 'picker',
      sessionId: null,
      messages: [],
      tokensUsed: 0,
      streaming: false,
      streamingMessageId: null,
    });
    expand(p);
    void loadWorkspaces();
    fetchedCwdsRef.current.add(p);
    void loadConversations(p);
    setTab('local');
  };

  const openConv = async (cwd: string, row: ConversationRow) => {
    setOpeningId(row.id);
    // For SSH workspaces, kick off auto-login in the background using whatever
    // is on file. The conversation can open immediately — first chat send /
    // shell open will block on the connection if it isn't ready yet.
    const w = workspaces.find((x) => x.cwd === cwd);
    if (w && w.kind === 'ssh' && !w.sshConnected) {
      if (
        !autoLoginAttemptedRef.current.has(cwd) &&
        loginByCwd[cwd]?.kind !== 'submitting' &&
        loginByCwd[cwd]?.kind !== 'auto'
      ) {
        autoLoginAttemptedRef.current.add(cwd);
        if (w.hasStoredPassword) {
          void tryLogin(cwd);
        } else {
          void tryLogin(cwd, { tryAuto: true });
        }
      }
    }
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(row.id)}/messages?cwd=${encodeURIComponent(cwd)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        messages: ChatMessage[];
        oldestSeq: number | null;
        hasMoreOlder: boolean;
      };
      patch(active.id, { cwd });
      openConversation(active.id, row.id, {
        messages: data.messages,
        oldestSeq: data.oldestSeq,
        hasMoreOlder: data.hasMoreOlder,
      });
      expand(cwd);
      void loadWorkspaces();
    } catch {
      /* ignore */
    } finally {
      setOpeningId(null);
    }
  };

  const openNewIn = (cwd: string) => {
    patch(active.id, { cwd });
    openNewConversation(active.id);
    expand(cwd);
  };

  const onDisconnect = async (cwd: string) => {
    try {
      await fetch('/api/ssh/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
    } catch {
      /* ignore */
    }
    autoLoginAttemptedRef.current.delete(cwd);
    void loadWorkspaces();
  };

  // ---- Render --------------------------------------------------------------

  const filtered = workspaces.filter((w) =>
    tab === 'local' ? w.kind === 'local' : w.kind === 'ssh',
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          Workspaces
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadWorkspaces()}
            disabled={loading}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </button>
          {tab === 'ssh' ? (
            <button
              type="button"
              onClick={() => setSshOpen(true)}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-1.5 text-[10px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20"
              title="Add SSH connection"
            >
              <Plus className="h-3 w-3" />
              SSH
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              title="Add local folder"
            >
              <Plus className="h-3 w-3" />
              Folder
            </button>
          )}
        </div>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1 rounded-md border border-border/60 bg-muted/40 p-0.5">
        <TabButton
          active={tab === 'local'}
          onClick={() => setTab('local')}
          icon={<Folder className="h-3 w-3" />}
          label="Local"
          count={workspaces.filter((w) => w.kind === 'local').length}
        />
        <TabButton
          active={tab === 'ssh'}
          onClick={() => setTab('ssh')}
          icon={<Globe className="h-3 w-3" />}
          label="SSH"
          count={workspaces.filter((w) => w.kind === 'ssh').length}
        />
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-0.5">
        {error && (
          <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}

        {loading && workspaces.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-[11px] text-muted-foreground">
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            Loading...
          </div>
        ) : filtered.length === 0 ? (
          tab === 'local' ? (
            <EmptyLocal onPick={() => setPickerOpen(true)} />
          ) : (
            <EmptySsh onConnect={() => setSshOpen(true)} />
          )
        ) : tab === 'ssh' ? (
          <ul className="flex flex-col gap-1.5">
            {groupSshByHost(filtered).map((group) => {
              const isHostOpen = expandedHosts.has(group.key);
              const anchor = group.workspaces[0];
              const phase = loginByCwd[anchor.cwd];
              const isHostActive = group.workspaces.some(
                (w) => w.cwd === active.cwd,
              );
              return (
                <li
                  key={group.key}
                  className={cn(
                    'rounded-lg border transition-colors',
                    isHostActive
                      ? 'border-emerald-400/60 bg-emerald-500/[0.05]'
                      : 'border-border/50 bg-background/40 hover:border-border',
                  )}
                >
                  <div className="flex items-center gap-0.5 pr-1">
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedHosts((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        });
                        // First-time host expand: fire one silent attempt.
                        // Stored password → use it. Otherwise → auto-discover
                        // (agent + default ~/.ssh keys), so users with a
                        // normal SSH setup never see the password prompt.
                        if (
                          !group.connected &&
                          !autoLoginAttemptedRef.current.has(anchor.cwd) &&
                          loginByCwd[anchor.cwd]?.kind !== 'submitting' &&
                          loginByCwd[anchor.cwd]?.kind !== 'auto'
                        ) {
                          autoLoginAttemptedRef.current.add(anchor.cwd);
                          if (group.hasStoredPassword) {
                            void tryLogin(anchor.cwd);
                          } else {
                            void tryLogin(anchor.cwd, { tryAuto: true });
                          }
                        }
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                    >
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                          isHostOpen && 'rotate-90',
                        )}
                      />
                      <Globe
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          group.connected
                            ? 'text-emerald-400'
                            : 'text-muted-foreground/70',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium leading-tight">
                          {group.user}@{group.host}
                          {group.port !== 22 ? `:${group.port}` : ''}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground/80">
                          {group.workspaces.length} folder
                          {group.workspaces.length === 1 ? '' : 's'} ·{' '}
                          {formatRelative(group.lastUsed)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'ml-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full',
                          group.connected
                            ? 'bg-emerald-400 shadow-[0_0_4px_rgba(74,222,128,0.7)]'
                            : 'bg-muted-foreground/40',
                        )}
                        title={group.connected ? 'Connected' : 'Not connected'}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddFolderHost(group);
                      }}
                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-1.5 text-[10px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20"
                      title={`Add another folder on ${group.user}@${group.host}`}
                    >
                      <Plus className="h-3 w-3" />
                      Folder
                    </button>
                  </div>

                  {isHostOpen && (
                    <div className="border-t border-border/40 px-1.5 py-1.5">
                      {!group.connected && (
                        <SshLoginPanel
                          phase={phase ?? { kind: 'idle' }}
                          hasStoredPassword={group.hasStoredPassword}
                          onTryAuto={() => {
                            autoLoginAttemptedRef.current.delete(anchor.cwd);
                            void tryLogin(anchor.cwd, { tryAuto: true });
                          }}
                          onSubmitPassword={(password, remember) => {
                            void tryLogin(anchor.cwd, {
                              password: password || undefined,
                              remember: !!password && remember,
                            });
                          }}
                        />
                      )}

                      <ul className="flex flex-col gap-1">
                        {group.workspaces.map((w) => {
                          const isOpen = expanded.has(w.cwd);
                          const isCurrent = active.cwd === w.cwd;
                          const convs = convsByCwd[w.cwd];
                          const loadingConvs = !!convsLoading[w.cwd];
                          return (
                            <li
                              key={w.cwd}
                              className={cn(
                                'rounded-md border transition-colors',
                                isCurrent
                                  ? 'border-emerald-400/40 bg-emerald-500/[0.04]'
                                  : 'border-border/40 bg-background/30',
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => onWorkspaceClick(w)}
                                className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
                              >
                                <ChevronRight
                                  className={cn(
                                    'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                                    isOpen && 'rotate-90',
                                  )}
                                />
                                <Folder
                                  className={cn(
                                    'h-3 w-3 shrink-0',
                                    isCurrent
                                      ? 'text-emerald-300'
                                      : 'text-muted-foreground',
                                  )}
                                />
                                <span className="min-w-0 flex-1">
                                  <span
                                    className="block truncate text-[11.5px] font-medium leading-tight"
                                    title={w.cwd}
                                  >
                                    {pathTail(parseCwd(w.cwd).path)}
                                  </span>
                                  <span
                                    className="block truncate font-mono text-[10px] text-muted-foreground/70"
                                    title={parseCwd(w.cwd).path}
                                  >
                                    {parseCwd(w.cwd).path}
                                  </span>
                                </span>
                                <span className="ml-1 shrink-0 text-[10px] text-muted-foreground/70">
                                  {w.conversationCount > 0
                                    ? `${w.conversationCount}`
                                    : '·'}
                                </span>
                              </button>

                              {isOpen && (
                                <div className="border-t border-border/40 px-1.5 py-1.5">
                                  {loadingConvs ? (
                                    <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Loading...
                                    </div>
                                  ) : convs && convs.length > 0 ? (
                                    <ul className="flex flex-col gap-0.5">
                                      {convs.map((c) => {
                                        const isLast =
                                          w.lastConversation?.id === c.id;
                                        const isCur =
                                          active.cwd === w.cwd &&
                                          active.sessionId === c.id;
                                        const label =
                                          c.title ??
                                          `Conversation ${shortId(c.id)}`;
                                        return (
                                          <li key={c.id}>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                void openConv(w.cwd, c)
                                              }
                                              disabled={openingId === c.id}
                                              className={cn(
                                                'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors',
                                                isCur
                                                  ? 'bg-emerald-500/15 text-emerald-50'
                                                  : 'hover:bg-secondary',
                                                openingId === c.id && 'opacity-60',
                                              )}
                                              title={label}
                                            >
                                              {isLast ? (
                                                <Sparkles className="h-3 w-3 shrink-0 text-amber-300" />
                                              ) : (
                                                <span className="ml-0.5 inline-block h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
                                              )}
                                              <span className="min-w-0 flex-1">
                                                <span className="block truncate text-[11.5px] leading-tight">
                                                  {label}
                                                </span>
                                                <span className="block truncate text-[10px] text-muted-foreground/70">
                                                  {formatRelative(c.updatedAt)}
                                                  {c.source === 'sdk' &&
                                                    ' · external'}
                                                </span>
                                              </span>
                                              {openingId === c.id && (
                                                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-400" />
                                              )}
                                            </button>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  ) : (
                                    <div className="px-1 py-1 text-[10px] text-muted-foreground/70">
                                      No conversations yet.
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openNewIn(w.cwd)}
                                    className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-blue-400/40 bg-blue-500/10 px-2 py-1 text-[11px] font-medium text-blue-200 transition-colors hover:bg-blue-500/20"
                                  >
                                    <MessageSquarePlus className="h-3 w-3" />
                                    New chat
                                  </button>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>

                      {group.connected && (
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            onClick={() => void onDisconnect(anchor.cwd)}
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="Close the SSH connection"
                          >
                            <LogOut className="h-3 w-3" />
                            Disconnect
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((w) => {
              const isOpen = expanded.has(w.cwd);
              const isActive = active.cwd === w.cwd;
              const convs = convsByCwd[w.cwd];
              const loadingConvs = !!convsLoading[w.cwd];
              const isSsh = w.kind === 'ssh';
              const parsed = parseCwd(w.cwd);
              const phase = loginByCwd[w.cwd];
              return (
                <li
                  key={w.cwd}
                  className={cn(
                    'rounded-lg border transition-colors',
                    isActive
                      ? isSsh
                        ? 'border-emerald-400/60 bg-emerald-500/[0.06]'
                        : 'border-blue-400/60 bg-blue-500/[0.06]'
                      : 'border-border/50 bg-background/40 hover:border-border',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onWorkspaceClick(w)}
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                    {isSsh ? (
                      <Globe
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          w.sshConnected
                            ? isActive
                              ? 'text-emerald-300'
                              : 'text-emerald-400/85'
                            : 'text-muted-foreground/70',
                        )}
                      />
                    ) : (
                      <Folder
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          isActive ? 'text-blue-300' : 'text-muted-foreground',
                        )}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[12px] font-medium leading-tight"
                        title={w.cwd}
                      >
                        {shortLabel(w.cwd)}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground/80">
                        {isSsh && parsed.kind === 'ssh' ? `${parsed.user}@${parsed.host} · ` : ''}
                        {w.conversationCount > 0
                          ? `${w.conversationCount} chat${w.conversationCount === 1 ? '' : 's'} · ${formatRelative(w.lastUsed)}`
                          : `picked ${formatRelative(w.lastUsed)}`}
                      </span>
                    </span>
                    {isSsh && (
                      <span
                        className={cn(
                          'ml-1 inline-flex h-1.5 w-1.5 shrink-0 rounded-full',
                          w.sshConnected
                            ? 'bg-emerald-400 shadow-[0_0_4px_rgba(74,222,128,0.7)]'
                            : 'bg-muted-foreground/40',
                        )}
                        aria-label={w.sshConnected ? 'Connected' : 'Disconnected'}
                        title={w.sshConnected ? 'SSH connected' : 'Not connected'}
                      />
                    )}
                    {isActive && !isSsh && (
                      <span
                        className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400"
                        aria-label="Active"
                      />
                    )}
                  </button>

                  {isOpen && (
                    <div className="border-t border-border/40 px-1.5 py-1.5">
                      <div
                        className="mb-1 break-all px-1 font-mono text-[10px] leading-snug text-muted-foreground/70"
                        title={w.cwd}
                      >
                        {w.cwd}
                      </div>

                      {/* Inline SSH login banner when not connected. Always
                          shown alongside conversations so the user can still
                          browse + click past chats while we (re)connect. */}
                      {isSsh && !w.sshConnected && (
                        <SshLoginPanel
                          phase={phase ?? { kind: 'idle' }}
                          hasStoredPassword={w.hasStoredPassword}
                          onTryAuto={() => {
                            autoLoginAttemptedRef.current.delete(w.cwd);
                            void tryLogin(w.cwd, { tryAuto: true });
                          }}
                          onSubmitPassword={(password, remember) => {
                            void tryLogin(w.cwd, {
                              password: password || undefined,
                              remember: !!password && remember,
                            });
                          }}
                        />
                      )}

                      <>
                          {loadingConvs ? (
                            <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Loading...
                            </div>
                          ) : convs && convs.length > 0 ? (
                            <ul className="flex flex-col gap-0.5">
                              {convs.map((c) => {
                                const isLast = w.lastConversation?.id === c.id;
                                const isCurrent =
                                  active.cwd === w.cwd && active.sessionId === c.id;
                                const label =
                                  c.title ?? `Conversation ${shortId(c.id)}`;
                                return (
                                  <li key={c.id}>
                                    <button
                                      type="button"
                                      onClick={() => void openConv(w.cwd, c)}
                                      disabled={openingId === c.id}
                                      className={cn(
                                        'group/conv flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors',
                                        isCurrent
                                          ? 'bg-blue-500/15 text-blue-100'
                                          : 'hover:bg-secondary',
                                        openingId === c.id && 'opacity-60',
                                      )}
                                      title={label}
                                    >
                                      {isLast ? (
                                        <Sparkles className="h-3 w-3 shrink-0 text-amber-300" />
                                      ) : (
                                        <span className="ml-0.5 inline-block h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
                                      )}
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[11.5px] leading-tight">
                                          {label}
                                        </span>
                                        <span className="block truncate text-[10px] text-muted-foreground/70">
                                          {formatRelative(c.updatedAt)}
                                          {c.source === 'sdk' && ' · external'}
                                        </span>
                                      </span>
                                      {openingId === c.id && (
                                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-400" />
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <div className="px-1 py-1 text-[10px] text-muted-foreground/70">
                              No conversations yet.
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openNewIn(w.cwd)}
                              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-blue-400/40 bg-blue-500/10 px-2 py-1 text-[11px] font-medium text-blue-200 transition-colors hover:bg-blue-500/20"
                            >
                              <MessageSquarePlus className="h-3 w-3" />
                              New chat
                            </button>
                            {isSsh && (
                              <button
                                type="button"
                                onClick={() => void onDisconnect(w.cwd)}
                                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                title="Close the SSH connection"
                              >
                                <LogOut className="h-3 w-3" />
                                Disconnect
                              </button>
                            )}
                          </div>
                        </>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <FolderPicker
        open={pickerOpen}
        initialPath={active.cwd && !active.cwd.startsWith('ssh://') ? active.cwd : null}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => void onAddFolder(p)}
      />
      {addFolderHost && (
        <RemoteFolderPicker
          anchorCwd={addFolderHost.workspaces[0].cwd}
          hostLabel={`${addFolderHost.user}@${addFolderHost.host}${addFolderHost.port !== 22 ? `:${addFolderHost.port}` : ''}`}
          onClose={() => setAddFolderHost(null)}
          onAdded={(cwd) => {
            patch(active.id, {
              cwd,
              view: 'picker',
              sessionId: null,
              messages: [],
              tokensUsed: 0,
              streaming: false,
              streamingMessageId: null,
            });
            expand(cwd);
            fetchedCwdsRef.current.add(cwd);
            void loadConversations(cwd);
            void loadWorkspaces();
          }}
        />
      )}
      {sshOpen && (
        <ConnectSshModal
          open
          onClose={() => setSshOpen(false)}
          onConnected={(cwd) => {
            patch(active.id, {
              cwd,
              view: 'picker',
              sessionId: null,
              messages: [],
              tokensUsed: 0,
              streaming: false,
              streamingMessageId: null,
            });
            setTab('ssh');
            expand(cwd);
            fetchedCwdsRef.current.add(cwd);
            void loadConversations(cwd);
            void loadWorkspaces();
          }}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={cn(
          'rounded px-1 text-[9.5px]',
          active ? 'bg-muted text-foreground/80' : 'bg-muted/40 text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function SshLoginPanel({
  phase,
  hasStoredPassword,
  onTryAuto,
  onSubmitPassword,
}: {
  phase: LoginPhase;
  /** A password is on file for this workspace. */
  hasStoredPassword: boolean;
  /** Connect using the local SSH agent + every key under ~/.ssh. */
  onTryAuto: () => void;
  /** Sign in with a typed password (optionally remembered). */
  onSubmitPassword: (password: string, remember: boolean) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(true);

  if (phase.kind === 'auto' || phase.kind === 'submitting') {
    return (
      <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/[0.05] px-2 py-1.5 text-[11px] text-emerald-200">
        <Loader2 className="h-3 w-3 animate-spin" />
        Connecting…
      </div>
    );
  }

  const promptError = phase.kind === 'prompt' ? phase.error : undefined;
  const fatalError = phase.kind === 'error' ? phase.message : undefined;
  const error = fatalError ?? promptError;

  return (
    <div className="mb-1.5 space-y-2 rounded-md border border-amber-400/30 bg-amber-500/[0.05] p-2">
      <div className="flex items-center gap-1.5 text-[11px] text-amber-200">
        <Unplug className="h-3 w-3" />
        <span>Not connected.</span>
      </div>
      <button
        type="button"
        onClick={onTryAuto}
        className="w-full rounded-md bg-emerald-500/25 px-3 py-1.5 text-[12px] font-semibold text-emerald-100 hover:bg-emerald-500/35"
        title="Connect with the SSH agent and every private key under ~/.ssh (including IdentityFile entries in ~/.ssh/config)."
      >
        Connect with SSH
      </button>
      <div className="text-[10px] leading-snug text-emerald-200/70">
        Uses your SSH agent and every key under{' '}
        <span className="font-mono">~/.ssh</span> (config-aware).
      </div>

      {/* Password fallback — collapsed by default so the primary path stays
          uncluttered. Lives here for servers that genuinely require a
          password, and for diagnosing key-only auth failures. */}
      {!showPassword ? (
        <button
          type="button"
          onClick={() => setShowPassword(true)}
          className="text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Use a password instead
        </button>
      ) : (
        <div className="space-y-1 rounded-md border border-border/40 bg-background/30 p-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground/70">
            <span>Password</span>
            <button
              type="button"
              onClick={() => {
                setShowPassword(false);
                setPw('');
              }}
              className="text-[10px] normal-case text-muted-foreground hover:text-foreground"
            >
              hide
            </button>
          </div>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (pw || hasStoredPassword)) {
                onSubmitPassword(pw, !!pw && remember);
              }
            }}
            placeholder={
              hasStoredPassword
                ? '(stored) press Sign in, or type a new one'
                : 'SSH password'
            }
            autoComplete="new-password"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-[11.5px] outline-none focus:border-ring"
          />
          <div className="flex items-center justify-between gap-2">
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground',
                !pw && 'opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={remember}
                disabled={!pw}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3 w-3"
              />
              Remember password
            </label>
            <button
              type="button"
              onClick={() => onSubmitPassword(pw, !!pw && remember)}
              disabled={!pw && !hasStoredPassword}
              className="rounded-md bg-muted/60 px-2 py-1 text-[10.5px] font-medium text-foreground hover:bg-muted disabled:opacity-40"
            >
              Sign in with password
            </button>
          </div>
        </div>
      )}

      {error && <div className="text-[10.5px] text-red-300">{error}</div>}
    </div>
  );
}

function EmptyLocal({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-border/60 p-4 text-center">
      <div className="mb-2 rounded-full bg-muted/60 p-2.5">
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="text-xs font-medium">No local workspaces yet</div>
      <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Pick a folder for Claude<br />to run in.
      </div>
      <button
        type="button"
        onClick={onPick}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        Select Folder
      </button>
    </div>
  );
}

function EmptySsh({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-border/60 p-4 text-center">
      <div className="mb-2 rounded-full bg-emerald-500/10 p-2.5">
        <Globe className="h-4 w-4 text-emerald-400" />
      </div>
      <div className="text-xs font-medium">No SSH connections yet</div>
      <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Connect to a remote host<br />to give Claude access there.
      </div>
      <button
        type="button"
        onClick={onConnect}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20"
      >
        <Plus className="h-3.5 w-3.5" />
        New SSH connection
      </button>
    </div>
  );
}
