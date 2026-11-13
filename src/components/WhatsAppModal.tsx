'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Send, Unlink, X } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa6';
import { cn } from '@/lib/cn';

type Status = {
  linked: boolean;
  me: { jid: string; number: string; name: string | null } | null;
  socket: 'closed' | 'connecting' | 'open';
  pairing: boolean;
  /** Ready-to-render image of the current QR code; null when not pairing. */
  qrImage: string | null;
  error: string | null;
  sendsLastHour: number;
  hourlyCap: number;
  knownChats: number;
  recent: { at: number; to: string; body: string; ok: boolean; error: string | null }[];
};

type Action = 'connect' | 'cancel' | 'test' | 'unlink';

type Props = {
  open: boolean;
  onClose: () => void;
};

/** Poll quickly while a QR is on screen (it rotates every ~20 s), slowly otherwise. */
const POLL_PAIRING_MS = 1500;
const POLL_IDLE_MS = 6000;

/**
 * Link the user's WhatsApp account to cloudchat, once.
 *
 * Linking is what lets agents send messages: with it done, the built-in
 * `whatsapp` MCP server can be switched on per folder (MCP button) or by
 * asking an agent to attach it. This modal only handles the part that needs a
 * person — scanning the QR code — plus unlinking and a self-addressed test.
 */
export default function WhatsAppModal({ open, onClose }: Props) {
  // Mount-gate so each open starts from clean state (same as NotebookModal).
  if (!open) return null;
  return <WhatsAppPanel onClose={onClose} />;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function WhatsAppPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let delay = POLL_IDLE_MS;
      try {
        const res = await fetch('/api/whatsapp');
        if (!res.ok) throw new Error('Could not read the WhatsApp status');
        const data = (await res.json()) as Status;
        if (cancelled) return;
        setStatus(data);
        if (data.pairing || data.socket === 'connecting') delay = POLL_PAIRING_MS;
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Status failed');
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const act = async (action: Action) => {
    if (action === 'unlink' && !confirm('Unlink WhatsApp from cloudchat? Agents will no longer be able to send messages until you link again.')) {
      return;
    }
    setBusy(action);
    setError(null);
    setTested(false);
    try {
      const res = await fetch('/api/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as Status & { error?: string };
      // The server returns fresh status even when the action itself failed.
      if (data.linked !== undefined) setStatus(data);
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      if (action === 'test') setTested(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const shownError = error ?? status?.error ?? null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FaWhatsapp className="h-4 w-4 text-emerald-400" />
            <span>WhatsApp</span>
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
          {!status ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking WhatsApp...
            </div>
          ) : status.linked ? (
            <LinkedView status={status} busy={busy} tested={tested} onAct={act} />
          ) : status.pairing ? (
            <PairingView status={status} busy={busy} onAct={act} />
          ) : (
            <IntroView busy={busy} onAct={act} />
          )}

          {shownError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11.5px] leading-snug text-red-300">
              {shownError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-border/70 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-secondary"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ViewProps = { busy: Action | null; onAct: (a: Action) => void | Promise<void> };

const primaryBtn =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-50';
const ghostBtn =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50';

function IntroView({ busy, onAct }: ViewProps) {
  return (
    <>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Link your WhatsApp so agents can send messages for you when you ask. You scan a QR code once,
        from your phone, the same way you would link WhatsApp Web.
      </p>
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-200/90">
        This uses an unofficial client, not Meta&apos;s Business API. WhatsApp can restrict accounts
        that behave like bots, so agents here send one message at a time, paced, with an hourly cap.
        Use it for your own messages, not for bulk sending.
      </p>
      <button
        type="button"
        onClick={() => void onAct('connect')}
        disabled={busy !== null}
        className={primaryBtn}
      >
        {busy === 'connect' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FaWhatsapp className="h-3.5 w-3.5" />
        )}
        Connect WhatsApp
      </button>
    </>
  );
}

function PairingView({ status, busy, onAct }: ViewProps & { status: Status }) {
  return (
    <>
      <ol className="list-decimal space-y-0.5 pl-4 text-[12px] leading-relaxed text-muted-foreground">
        <li>Open WhatsApp on your phone</li>
        <li>
          <span className="text-foreground">Settings → Linked devices → Link a device</span>
        </li>
        <li>Point the camera at this code</li>
      </ol>
      <div className="mx-auto flex h-[264px] w-[264px] items-center justify-center rounded-lg bg-white p-1">
        {status.qrImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={status.qrImage} alt="WhatsApp link QR code" className="h-full w-full" />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
        )}
      </div>
      <p className="text-center text-[10.5px] text-muted-foreground/70">
        The code refreshes by itself. This window updates as soon as you scan.
      </p>
      <button
        type="button"
        onClick={() => void onAct('cancel')}
        disabled={busy !== null}
        className={ghostBtn}
      >
        Cancel
      </button>
    </>
  );
}

function LinkedView({
  status,
  busy,
  tested,
  onAct,
}: ViewProps & { status: Status; tested: boolean }) {
  return (
    <>
      <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
        <div className="min-w-0 text-[12px] leading-snug">
          <div className="font-medium text-emerald-200">
            Linked as +{status.me?.number}
            {status.me?.name ? ` (${status.me.name})` : ''}
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            {status.socket === 'open'
              ? 'Connected now. It disconnects by itself when idle.'
              : status.socket === 'connecting'
                ? 'Connecting...'
                : 'Idle. It connects when an agent needs it.'}{' '}
            Sent this hour: {status.sendsLastHour}/{status.hourlyCap}.
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border/60 bg-background/40 p-2.5 text-[11.5px] leading-snug text-muted-foreground">
        To let agents use it, switch on <span className="font-mono text-foreground">whatsapp</span> in a
        folder&apos;s <span className="text-foreground">MCP</span> list, or tell an agent
        &ldquo;attach the whatsapp MCP&rdquo;. It stays off in every folder until you do.
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void onAct('test')}
          disabled={busy !== null}
          className={cn(primaryBtn, 'flex-1')}
        >
          {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send a test to myself
        </button>
        <button
          type="button"
          onClick={() => void onAct('unlink')}
          disabled={busy !== null}
          className={cn(ghostBtn, 'hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300')}
        >
          {busy === 'unlink' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
          Unlink
        </button>
      </div>
      {tested && (
        <div className="flex items-center gap-1 text-[11.5px] text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          Test sent. Check your own WhatsApp chat.
        </div>
      )}

      {status.recent.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted-foreground/70">
            Recent sends
          </div>
          <ul className="space-y-1">
            {status.recent.map((r, i) => (
              <li
                key={`${r.at}-${i}`}
                className="rounded border border-border/50 bg-background/40 px-2 py-1 text-[11px] leading-snug"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{r.to}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">{ago(r.at)}</span>
                </div>
                <div className={cn('truncate', r.ok ? 'text-muted-foreground' : 'text-red-300')}>
                  {r.ok ? r.body : `Failed: ${r.error ?? 'unknown error'}`}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
