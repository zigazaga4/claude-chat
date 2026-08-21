'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';

type Transport = 'local-stdio' | 'ssh-stdio' | 'http';

type WireServer = {
  id: string;
  name: string;
  transport: Transport;
  command: string | null;
  url: string | null;
  hostRef: string | null;
  enabled: boolean;
  status: string | null;
  envKeys: string[];
  headerKeys: string[];
  attachedCwds: string[];
  attached: boolean;
  resolvedHost: string | null;
  updatedAt: number;
};

type Probe = { ok: boolean; tools?: string[]; error?: string };

type Props = {
  open: boolean;
  /** Folder these attachments belong to. */
  cwd: string;
  /** Human label for the header. */
  label: string;
  onClose: () => void;
};

const TRANSPORT_LABELS: Record<Transport, string> = {
  'ssh-stdio': 'SSH command',
  'local-stdio': 'Local command',
  http: 'HTTP endpoint',
};

/**
 * Manage which MCP servers are live in ONE folder.
 *
 * The two-layer model is the thing this screen has to make obvious: server
 * definitions are global (set one up once, use it anywhere), but what is
 * switched on is a property of the folder. So the list shows every definition
 * with a per-folder toggle, and the footnote for an SSH server explains which
 * host it will actually run on here.
 */
export default function McpServersModal({ open, cwd, label, onClose }: Props) {
  // Mount-gate so each open starts from clean state rather than resetting in
  // an effect — same shape as NotebookModal.
  if (!open) return null;
  return <McpManager cwd={cwd} label={label} onClose={onClose} />;
}

function McpManager({ cwd, label, onClose }: Omit<Props, 'open'>) {
  const [servers, setServers] = useState<WireServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [adding, setAdding] = useState(false);

  const isSshFolder = cwd.startsWith('ssh://');

  const load = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json()) as { servers?: WireServer[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to load MCP servers');
      setServers(data.servers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // `cwd` is fixed for the life of this mount (the modal is keyed by folder).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleAttached = async (server: WireServer, attached: boolean) => {
    setBusy(server.name);
    setError(null);
    try {
      const res = await fetch('/api/mcp-servers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: server.name, cwd, attached }),
      });
      const data = (await res.json()) as { error?: string; probe?: Probe };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      if (data.probe) setProbes((p) => ({ ...p, [server.name]: data.probe! }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const reconnect = async (server: WireServer) => {
    setBusy(server.name);
    try {
      const res = await fetch('/api/mcp-servers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: server.name, cwd, attached: true }),
      });
      const data = (await res.json()) as { probe?: Probe; error?: string };
      if (data.probe) setProbes((p) => ({ ...p, [server.name]: data.probe! }));
      if (!res.ok) setError(data.error ?? 'Failed');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: WireServer) => {
    const others = server.attachedCwds.filter((c) => c !== cwd);
    const msg =
      others.length > 0
        ? `Delete "${server.name}" everywhere? It is also used by ${others.length} other folder(s).`
        : `Delete "${server.name}"?`;
    if (!confirm(msg)) return;
    setBusy(server.name);
    try {
      await fetch(`/api/mcp-servers?name=${encodeURIComponent(server.name)}`, {
        method: 'DELETE',
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const attachedCount = servers.filter((s) => s.attached).length;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Plug className="h-4 w-4 shrink-0 text-primary" />
            <span className="shrink-0">MCP servers</span>
            <span
              className="truncate text-[11px] font-normal text-muted-foreground"
              title={cwd}
            >
              · {label}
            </span>
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

        <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            Servers switched on here are available to every conversation in this
            folder. Definitions are shared across folders — switch one on
            wherever you need it. Changes apply to the next message.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : servers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-[11.5px] text-muted-foreground">
              No MCP servers configured yet.
              <br />
              Add one below, or just ask the assistant to set one up for you.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {servers.map((s) => {
                const probe = probes[s.name];
                const failed =
                  probe?.ok === false ||
                  (s.status?.startsWith('failed') && s.attached && !probe?.ok);
                return (
                  <li
                    key={s.id}
                    className={cn(
                      'rounded-lg border p-2.5 transition-colors',
                      s.attached
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border/60 bg-background/40',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={s.attached}
                        disabled={busy === s.name}
                        onClick={() => void toggleAttached(s, !s.attached)}
                        title={
                          s.attached
                            ? 'Switch off in this folder'
                            : 'Switch on in this folder'
                        }
                        className={cn(
                          'mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
                          s.attached
                            ? 'border-primary/50 bg-primary/70'
                            : 'border-border bg-muted',
                          busy === s.name && 'opacity-50',
                        )}
                      >
                        <span
                          className={cn(
                            'h-3.5 w-3.5 rounded-full bg-background transition-transform',
                            s.attached ? 'translate-x-[18px]' : 'translate-x-[3px]',
                          )}
                        />
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-medium">
                            {s.name}
                          </span>
                          <span className="shrink-0 rounded border border-border/60 bg-muted/50 px-1 text-[9.5px] uppercase tracking-wide text-muted-foreground">
                            {TRANSPORT_LABELS[s.transport]}
                          </span>
                          {busy === s.name && (
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                          )}
                        </div>
                        <div
                          className="truncate font-mono text-[10.5px] text-muted-foreground/80"
                          title={s.command ?? s.url ?? ''}
                        >
                          {s.command ?? s.url}
                        </div>
                        {s.transport === 'ssh-stdio' && (
                          <div className="truncate text-[10px] text-muted-foreground/70">
                            {s.hostRef
                              ? `pinned to ${s.hostRef}`
                              : s.resolvedHost
                                ? `runs on this folder's host`
                                : 'needs an SSH folder — this one is local'}
                          </div>
                        )}
                        {s.attachedCwds.filter((c) => c !== cwd).length > 0 && (
                          <div className="text-[10px] text-muted-foreground/60">
                            also on{' '}
                            {s.attachedCwds.filter((c) => c !== cwd).length} other
                            folder(s)
                          </div>
                        )}
                        {probe?.ok && (
                          <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-emerald-300">
                            <Check className="h-3 w-3" />
                            {probe.tools?.length ?? 0} tool
                            {probe.tools?.length === 1 ? '' : 's'}
                          </div>
                        )}
                        {failed && (
                          <div className="mt-0.5 break-words text-[10.5px] text-red-300">
                            {probe?.error ?? s.status}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-0.5">
                        {s.attached && (
                          <button
                            type="button"
                            onClick={() => void reconnect(s)}
                            disabled={busy === s.name}
                            title="Reconnect and list tools"
                            className="rounded p-1 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void remove(s)}
                          disabled={busy === s.name}
                          title="Delete this server everywhere"
                          className="rounded p-1 text-muted-foreground/60 hover:bg-red-500/15 hover:text-red-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] text-red-300">
              {error}
            </div>
          )}

          {adding ? (
            <AddServerForm
              cwd={cwd}
              isSshFolder={isSshFolder}
              onCancel={() => setAdding(false)}
              onSaved={async (name, probe) => {
                setAdding(false);
                if (probe) setProbes((p) => ({ ...p, [name]: probe }));
                await load();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              Add MCP server
            </button>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/70 px-4 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            {attachedCount} on in this folder · {servers.length} defined
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border/70 px-3 py-1.5 text-[11.5px] hover:bg-secondary"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AddServerForm({
  cwd,
  isSshFolder,
  onCancel,
  onSaved,
}: {
  cwd: string;
  isSshFolder: boolean;
  onCancel: () => void;
  onSaved: (name: string, probe: Probe | null) => void | Promise<void>;
}) {
  // An SSH folder defaults to running the server on its own host — the common
  // case, and the one that needs no extra typing.
  const [transport, setTransport] = useState<Transport>(
    isSshFolder ? 'ssh-stdio' : 'local-stdio',
  );
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [hostRef, setHostRef] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          transport,
          command: transport === 'http' ? '' : command,
          url: transport === 'http' ? url : '',
          hostRef: transport === 'ssh-stdio' ? hostRef : '',
          cwd,
        }),
      });
      const data = (await res.json()) as { error?: string; probe?: Probe };
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      await onSaved(name, data.probe ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    name.trim().length > 0 &&
    (transport === 'http' ? url.trim().length > 0 : command.trim().length > 0);

  const inputCls =
    'w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-[12px] outline-none focus:border-primary/50';

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/40 p-3">
      <div className="flex gap-1">
        {(Object.keys(TRANSPORT_LABELS) as Transport[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTransport(t)}
            className={cn(
              'flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors',
              transport === t
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-secondary',
            )}
          >
            {TRANSPORT_LABELS[t]}
          </button>
        ))}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (becomes the tool prefix, e.g. blender)"
        className={inputCls}
      />

      {transport === 'http' ? (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:3000/mcp"
          className={cn(inputCls, 'font-mono')}
        />
      ) : (
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={
            transport === 'ssh-stdio'
              ? 'Command to run on the host, e.g. uvx blender-mcp'
              : 'Command to run locally, e.g. uvx blender-mcp'
          }
          className={cn(inputCls, 'font-mono')}
        />
      )}

      {transport === 'ssh-stdio' && (
        <>
          <input
            value={hostRef}
            onChange={(e) => setHostRef(e.target.value)}
            placeholder={
              isSshFolder
                ? "Optional: pin to ssh://user@host/path (blank = this folder's host)"
                : 'Required here: ssh://user@host:port/path'
            }
            className={cn(inputCls, 'font-mono')}
          />
          <p className="text-[10px] leading-snug text-muted-foreground/70">
            {isSshFolder
              ? "Left blank, this server follows whichever folder it's switched on in — so the same definition works across machines."
              : 'This folder is local, so an SSH server needs an explicit host.'}
          </p>
        </>
      )}

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border/70 px-2.5 py-1 text-[11.5px] hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSave || saving}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[11.5px] font-medium',
            canSave && !saving
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          Save & connect
        </button>
      </div>
    </div>
  );
}
