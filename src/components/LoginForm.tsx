'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import Logo from './Logo';

/**
 * The password screen. Sized for a phone first — this is the one page that is
 * guaranteed to be met on a small screen, since it is what stands between the
 * tailnet and a shell on the machine.
 */
export default function LoginForm({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Could not sign in.');
        setPassword('');
        setBusy(false);
        return;
      }
      // A full navigation rather than a router push: the cookie needs to be on
      // the document request so the proxy lets the app render.
      const next = new URLSearchParams(window.location.search).get('next');
      // Only ever bounce to a path on this origin — an absolute URL here would
      // turn the login page into an open redirect.
      const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      window.location.replace(dest);
    } catch {
      setError('Network error. Is the server still running?');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full w-full items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo showWordmark={false} className="scale-125" />
          <h1 className="text-lg font-semibold tracking-tight text-foreground">claude chat</h1>
          <p className="text-xs text-muted-foreground">
            This machine is locked. Enter the password to continue.
          </p>
        </div>

        {!configured ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-200">
            <p className="mb-2 font-semibold">No password is set on the server.</p>
            <p>
              Add <code className="rounded bg-black/30 px-1 py-0.5">APP_PASSWORD</code> to{' '}
              <code className="rounded bg-black/30 px-1 py-0.5">.env.local</code> and restart the
              app. Until then nothing can sign in — the gate fails closed on purpose.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                // Lets a phone password manager offer to fill and then save it.
                autoComplete="current-password"
                autoFocus
                enterKeyHint="go"
                placeholder="Password"
                aria-label="Password"
                disabled={busy}
                className="h-12 w-full rounded-lg border border-border bg-card pl-10 pr-3 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60 focus:ring-1 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>

            {error && (
              <p role="alert" className="text-xs text-red-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !password}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? 'Checking…' : 'Unlock'}
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground/70">
          Reachable only from your tailnet. Sessions last 30 days per device.
        </p>
      </div>
    </div>
  );
}
