'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Folder,
  FolderPlus,
  Globe,
  Home,
  Loader2,
  X,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/cn';

type TestResp = {
  ok: boolean;
  error?: string;
  hostFingerprint?: string;
  home?: string;
  uname?: string;
  distro?: string;
};

type ConnectResp = {
  ok?: boolean;
  cwd?: string;
  hostFingerprint?: string;
  error?: string;
};

type BrowseResult = {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string }[];
  error?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onConnected: (cwd: string) => void;
};

export default function ConnectSshModal({ open, onClose, onConnected }: Props) {
  const [step, setStep] = useState<'config' | 'browse'>('config');
  // The user types a literal ssh command; the server resolves it (incl.
  // ~/.ssh/config aliases) into these concrete connection params.
  const [command, setCommand] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [user, setUser] = useState('');
  const [identityPath, setIdentityPath] = useState('');
  const [useAgent] = useState(true);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [pendingBrowse, setPendingBrowse] = useState<{
    path: string;
  } | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Resolve the typed ssh command into concrete params, then test the
  // connection with them — one click for the user.
  const onTest = async () => {
    if (!command.trim()) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    setResolvedLabel(null);
    try {
      const pr = await fetch('/api/ssh/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const pd = (await pr.json()) as {
        ok?: boolean;
        host?: string;
        port?: number;
        user?: string;
        identityPath?: string | null;
        label?: string;
        error?: string;
      };
      if (!pd.ok || !pd.host || !pd.user) {
        setError(pd.error ?? 'Could not understand that ssh command.');
        return;
      }
      // Stash resolved params so the browse + connect steps reuse them.
      setHost(pd.host);
      setPort(pd.port && pd.port > 0 ? pd.port : 22);
      setUser(pd.user);
      setIdentityPath(pd.identityPath ?? '');
      setResolvedLabel(pd.label ?? null);

      const res = await fetch('/api/ssh/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: pd.host,
          port: pd.port && pd.port > 0 ? pd.port : 22,
          user: pd.user,
          identityPath: pd.identityPath ?? null,
          useAgent,
          password: password || undefined,
        }),
      });
      const data = (await res.json()) as TestResp;
      setTestResult(data);
      if (!data.ok) setError(data.error ?? 'Connection failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const onAdvance = () => {
    if (!testResult?.ok) return;
    setStep('browse');
    void doBrowse(testResult.home || '~');
  };

  const doMkdir = async (parent: string, name: string): Promise<string> => {
    const res = await fetch('/api/ssh/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: host.trim(),
        port,
        user: user.trim(),
        identityPath: identityPath.trim() || null,
        useAgent,
        password: password || undefined,
        parent,
        name,
      }),
    });
    const data = (await res.json()) as { ok?: boolean; path?: string; error?: string };
    if (!res.ok || !data.path) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data.path;
  };

  const doBrowse = async (path: string) => {
    setBrowseLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        host: host.trim(),
        port: String(port),
        user: user.trim(),
        identityPath: identityPath.trim() || '',
        useAgent: useAgent ? '1' : '',
        password: password || '',
        path,
      });
      const res = await fetch(`/api/ssh/browse-probe?${params.toString()}`);
      const data = (await res.json()) as BrowseResult;
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setBrowseData(data);
      setBrowsePath(data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Browse failed');
    } finally {
      setBrowseLoading(false);
    }
  };

  const onConnect = async (path: string) => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch('/api/ssh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host.trim(),
          port,
          user: user.trim(),
          identityPath: identityPath.trim() || null,
          useAgent,
          password: password || undefined,
          rememberPassword: !!password && rememberPassword,
          path,
          expectedHostFingerprint: testResult?.hostFingerprint ?? null,
        }),
      });
      const data = (await res.json()) as ConnectResp;
      if (!res.ok || !data.cwd) {
        throw new Error(data.error || 'Connect failed');
      }
      onConnected(data.cwd);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connect failed');
    } finally {
      setConnecting(false);
    }
  };

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Scrolls inside itself once it outgrows the screen — this form is
          taller than a phone viewport with the keyboard up. */}
      <div className="scrollbar-thin relative max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {step === 'browse' && (
            <button
              type="button"
              onClick={() => setStep('config')}
              className="rounded p-1 text-muted-foreground hover:bg-secondary"
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <Globe className="h-4 w-4 text-emerald-400" />
          <div className="text-sm font-semibold">
            {step === 'config' ? 'Connect over SSH' : `Choose folder on ${host}`}
          </div>
        </div>

        {step === 'config' ? (
          <ConfigStep
            command={command}
            setCommand={setCommand}
            resolvedLabel={resolvedLabel}
            password={password}
            setPassword={setPassword}
            rememberPassword={rememberPassword}
            setRememberPassword={setRememberPassword}
            testing={testing}
            testResult={testResult}
            error={error}
            onTest={onTest}
            onAdvance={onAdvance}
            onCancel={onClose}
          />
        ) : (
          <BrowseStep
            data={browseData}
            path={browsePath}
            setPath={setBrowsePath}
            loading={browseLoading}
            error={error}
            connecting={connecting}
            doBrowse={doBrowse}
            doMkdir={doMkdir}
            onCancel={onClose}
            onConnect={onConnect}
            pending={pendingBrowse}
            setPending={setPendingBrowse}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ConfigStep(props: {
  command: string;
  setCommand: (v: string) => void;
  resolvedLabel: string | null;
  password: string;
  setPassword: (v: string) => void;
  rememberPassword: boolean;
  setRememberPassword: (v: boolean) => void;
  testing: boolean;
  testResult: TestResp | null;
  error: string | null;
  onTest: () => void;
  onAdvance: () => void;
  onCancel: () => void;
}) {
  const ready = !!props.command.trim();
  return (
    <div className="space-y-3 px-4 py-4">
      <Field label="SSH command">
        <input
          type="text"
          value={props.command}
          onChange={(e) => props.setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready && !props.testing) props.onTest();
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus
          placeholder="ssh leonard"
          className={inputCls + ' font-mono'}
        />
      </Field>
      <p className="text-[10.5px] leading-snug text-muted-foreground/80">
        Just type the ssh command you&apos;d use in a terminal — a{' '}
        <span className="font-mono">~/.ssh/config</span> alias like{' '}
        <span className="font-mono">ssh leonard</span>, or the full form{' '}
        <span className="font-mono">ssh -p 2222 ubuntu@1.2.3.4 -i ~/.ssh/key</span>.
        We read your <span className="font-mono">~/.ssh/config</span> and keys
        automatically.
      </p>
      {props.resolvedLabel && (
        <div className="rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
          → {props.resolvedLabel}
        </div>
      )}
      <Field label="Password (optional — only if the host needs one)">
        <input
          type="password"
          value={props.password}
          onChange={(e) => props.setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="leave blank to use key / agent"
          className={inputCls}
        />
      </Field>
      <label
        className={cn(
          'flex cursor-pointer items-center gap-2 text-xs',
          !props.password && 'opacity-60',
        )}
      >
        <input
          type="checkbox"
          checked={props.rememberPassword}
          disabled={!props.password}
          onChange={(e) => props.setRememberPassword(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        <span>Remember password (encrypted at rest)</span>
      </label>
      <p className="text-[10.5px] leading-snug text-muted-foreground/80">
        Password is held in memory for this session only. We persist the
        identity file path and the host fingerprint, never the password.
      </p>

      {props.testResult?.ok && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11.5px] text-emerald-200">
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected.
          </div>
          {props.testResult.distro && (
            <div className="mt-1 text-emerald-200/85">
              <span className="opacity-70">OS:</span> {props.testResult.distro}
            </div>
          )}
          {props.testResult.uname && (
            <div className="break-all font-mono text-[10.5px] text-emerald-200/70">
              {props.testResult.uname}
            </div>
          )}
          {props.testResult.hostFingerprint && (
            <div className="mt-1 break-all font-mono text-[10.5px] text-emerald-200/70">
              fp: {props.testResult.hostFingerprint}
            </div>
          )}
        </div>
      )}
      {props.error && (
        <div className="flex items-start gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] text-red-300">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{props.error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={props.onTest}
          disabled={!ready || props.testing}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {props.testing && <Loader2 className="h-3 w-3 animate-spin" />}
          Test
        </button>
        <button
          type="button"
          onClick={props.onAdvance}
          disabled={!props.testResult?.ok}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Pick folder
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function BrowseStep(props: {
  data: BrowseResult | null;
  path: string | null;
  setPath: (v: string) => void;
  loading: boolean;
  error: string | null;
  connecting: boolean;
  doBrowse: (p: string) => void;
  doMkdir: (parent: string, name: string) => Promise<string>;
  onCancel: () => void;
  onConnect: (p: string) => void;
  pending: { path: string } | null;
  setPending: (p: { path: string } | null) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onCreate = async () => {
    const name = newName.trim();
    if (!name || !props.data?.path) return;
    setCreatingBusy(true);
    setCreateError(null);
    try {
      await props.doMkdir(props.data.path, name);
      setNewName('');
      setCreating(false);
      props.doBrowse(props.data.path);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setCreatingBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => props.data?.parent && props.doBrowse(props.data.parent)}
          disabled={!props.data?.parent || props.loading}
          className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-30"
          aria-label="Up"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => props.data && props.doBrowse(props.data.home)}
          disabled={props.loading}
          className="rounded p-1 text-muted-foreground hover:bg-secondary"
          aria-label="Home"
        >
          <Home className="h-4 w-4" />
        </button>
        <input
          type="text"
          value={props.path ?? ''}
          onChange={(e) => props.setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && props.path) props.doBrowse(props.path);
          }}
          spellCheck={false}
          className="min-w-[9rem] flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
          placeholder="/absolute/path"
        />
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setNewName('');
            setCreateError(null);
          }}
          disabled={!props.data?.path || props.loading}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
          title={props.data?.path ? `Create folder under ${props.data.path}` : 'Create folder'}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New
        </button>
      </div>
      {creating && (
        <div className="flex flex-col gap-1 border-b border-border bg-emerald-500/[0.04] px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
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
                  setCreateError(null);
                }
              }}
              spellCheck={false}
              className="min-w-[9rem] flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
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
                setCreateError(null);
              }}
              disabled={creatingBusy}
              className="rounded p-1 text-muted-foreground hover:bg-secondary disabled:opacity-40"
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {createError && (
            <div className="pl-6 text-[10.5px] text-destructive">{createError}</div>
          )}
        </div>
      )}
      <div className="scrollbar-thin h-72 overflow-y-auto bg-card">
        {props.loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : props.error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
            {props.error}
          </div>
        ) : !props.data || props.data.entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Empty directory
          </div>
        ) : (
          <ul>
            {props.data.entries.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => props.doBrowse(e.path)}
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
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!props.data?.path || props.connecting}
          onClick={() => props.data?.path && props.onConnect(props.data.path)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {props.connecting && <Loader2 className="h-3 w-3 animate-spin" />}
          Use this folder
        </button>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:border-ring';

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  );
}
