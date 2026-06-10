/**
 * Server-side store of live shell sessions, keyed by id. Each session can be
 * backed by either a local PTY (node-pty) or an SSH shell channel (ssh2).
 * Output is buffered into a ring so a freshly-attached SSE stream can replay
 * anything the user missed, and is broadcast to any number of subscribers.
 *
 * State lives on globalThis so dev-mode HMR doesn't kill in-flight shells.
 */

import os from 'node:os';
import * as pty from 'node-pty';
import type { ClientChannel } from 'ssh2';
import { parseCwd } from '@/lib/cwd';
import { getHost, type ConnectOpts } from './sshHosts';
import { getStoredSshPassword, getWorkspace } from './workspaces';

export type ShellKind = 'local' | 'ssh';

export type ShellBackend = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

export type ShellSession = {
  id: string;
  cwd: string;
  kind: ShellKind;
  shell: string;
  backend: ShellBackend;
  /** Ring buffer of recent output for late subscribers. */
  scrollback: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  subscribers: Set<(chunk: string) => void>;
  exitSubscribers: Set<(code: number | null, signal: number | null) => void>;
  lastUsed: number;
};

const SCROLLBACK_BYTES = 256 * 1024;
const IDLE_KILL_MS = 2 * 60 * 60 * 1000;

type Store = Map<string, ShellSession>;

const KEY = '__cc_shellSessions__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) g[KEY] = new Map<string, ShellSession>();
const store = g[KEY] as Store;

function pickShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return 'powershell.exe';
  return '/bin/bash';
}

function newId(): string {
  return `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeSession(opts: {
  cwd: string;
  kind: ShellKind;
  shell: string;
  backend: ShellBackend;
}): ShellSession {
  return {
    id: newId(),
    cwd: opts.cwd,
    kind: opts.kind,
    shell: opts.shell,
    backend: opts.backend,
    scrollback: '',
    exited: false,
    exitCode: null,
    exitSignal: null,
    subscribers: new Set(),
    exitSubscribers: new Set(),
    lastUsed: Date.now(),
  };
}

function pushChunk(session: ShellSession, chunk: string) {
  session.scrollback += chunk;
  if (session.scrollback.length > SCROLLBACK_BYTES) {
    session.scrollback = session.scrollback.slice(
      session.scrollback.length - SCROLLBACK_BYTES,
    );
  }
  session.lastUsed = Date.now();
  for (const cb of session.subscribers) {
    try {
      cb(chunk);
    } catch {
      /* ignore */
    }
  }
}

function markExit(session: ShellSession, code: number | null, signal: number | null) {
  session.exited = true;
  session.exitCode = code;
  session.exitSignal = signal;
  for (const cb of session.exitSubscribers) {
    try {
      cb(code, signal);
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => store.delete(session.id), 30_000);
}

export function getSession(id: string): ShellSession | undefined {
  return store.get(id);
}

export async function startSession(opts: {
  cwd: string;
  cols?: number;
  rows?: number;
}): Promise<ShellSession> {
  const cols = Math.max(20, Math.min(opts.cols ?? 100, 500));
  const rows = Math.max(5, Math.min(opts.rows ?? 30, 200));
  const parsed = parseCwd(opts.cwd);

  if (parsed.kind === 'ssh') {
    return startSshSession(parsed, cols, rows);
  }
  return startLocalSession(parsed.path, cols, rows);
}

function startLocalSession(cwd: string, cols: number, rows: number): ShellSession {
  const shell = pickShell();
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') baseEnv[k] = v;
  }
  baseEnv.TERM = baseEnv.TERM || 'xterm-256color';
  baseEnv.COLORTERM = baseEnv.COLORTERM || 'truecolor';

  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || os.homedir(),
    env: baseEnv,
  });

  const backend: ShellBackend = {
    write: (d) => proc.write(d),
    resize: (c, r) => {
      try {
        proc.resize(c, r);
      } catch {
        /* ignore */
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
  const session = makeSession({ cwd, kind: 'local', shell, backend });
  proc.onData((chunk) => pushChunk(session, chunk));
  proc.onExit(({ exitCode, signal }) =>
    markExit(session, exitCode ?? null, signal ?? null),
  );
  store.set(session.id, session);
  return session;
}

async function startSshSession(
  parsed: ReturnType<typeof parseCwd> & { kind: 'ssh' },
  cols: number,
  rows: number,
): Promise<ShellSession> {
  const ws = getWorkspace(parsed.raw);
  const stored = getStoredSshPassword(parsed.raw);
  const connectOpts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws?.sshIdentityPath ?? null,
    useAgent: ws?.sshUseAgent ?? false,
    expectedHostFingerprint: ws?.sshKnownHostFp ?? null,
    password: stored ?? undefined,
  };
  const host = await getHost(connectOpts);
  const channel: ClientChannel = await host.openShell({
    cols,
    rows,
    cwd: parsed.path,
  });

  const backend: ShellBackend = {
    write: (d) => channel.write(d),
    resize: (c, r) => {
      try {
        channel.setWindow(r, c, 0, 0);
      } catch {
        /* ignore */
      }
    },
    kill: () => {
      try {
        channel.end();
      } catch {
        /* ignore */
      }
    },
  };

  const session = makeSession({
    cwd: parsed.raw,
    kind: 'ssh',
    shell: `ssh ${parsed.user}@${parsed.host}`,
    backend,
  });

  channel.on('data', (chunk: Buffer | string) => {
    pushChunk(session, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  channel.stderr.on('data', (chunk: Buffer | string) => {
    pushChunk(session, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  channel.on('exit', (code: number | null, signal: string | null) => {
    markExit(
      session,
      code ?? null,
      signal != null ? Number.NaN : null, // ssh signals are names, not numbers
    );
  });
  channel.on('close', () => {
    if (!session.exited) markExit(session, null, null);
  });

  store.set(session.id, session);
  return session;
}

export function writeInput(id: string, data: string): boolean {
  const s = store.get(id);
  if (!s || s.exited) return false;
  s.backend.write(data);
  s.lastUsed = Date.now();
  return true;
}

export function resize(id: string, cols: number, rows: number): boolean {
  const s = store.get(id);
  if (!s || s.exited) return false;
  const c = Math.max(20, Math.min(cols | 0, 500));
  const r = Math.max(5, Math.min(rows | 0, 200));
  s.backend.resize(c, r);
  return true;
}

export function killSession(id: string): boolean {
  const s = store.get(id);
  if (!s) return false;
  if (!s.exited) s.backend.kill();
  store.delete(id);
  return true;
}

const GC_KEY = '__cc_shellSessionsGc__';
if (!g[GC_KEY]) {
  g[GC_KEY] = setInterval(() => {
    const now = Date.now();
    for (const s of store.values()) {
      if (now - s.lastUsed > IDLE_KILL_MS) killSession(s.id);
    }
  }, 60_000);
  const handle = g[GC_KEY] as NodeJS.Timeout;
  if (typeof handle.unref === 'function') handle.unref();
}
