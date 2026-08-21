import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  checkPassword,
  isPasswordConfigured,
  issueSession,
  requestIsHttps,
  sessionCookieOptions,
} from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Throttling, so the password cannot simply be enumerated.
 *
 * In-process and per-origin-IP. That is the right granularity here: this is a
 * single-user app behind a tailnet, so the realistic attacker is a script, not
 * a botnet, and a lockout table in SQLite would buy nothing a Map does not.
 * The window resets wholesale rather than sliding — simpler, and the effect on
 * a real attacker is the same.
 */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request): string {
  // Behind `tailscale serve` the socket is always loopback, so the forwarded
  // header is the only thing that distinguishes one caller from another.
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : 'local';
}

/** Returns the number of seconds to wait, or 0 when the caller may try. */
function throttle(key: string, now: number): number {
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) return 0;
  if (rec.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((rec.resetAt - now) / 1000);
}

function recordFailure(key: string, now: number): void {
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  rec.count += 1;
}

export async function POST(req: Request) {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: 'No password is set on the server. Set APP_PASSWORD in .env.local and restart.' },
      { status: 503 },
    );
  }

  const now = Date.now();
  const key = clientKey(req);

  const wait = throttle(key, now);
  if (wait > 0) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` },
      { status: 429, headers: { 'retry-after': String(wait) } },
    );
  }

  let password = '';
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password === 'string') password = body.password;
  } catch {
    // Malformed body is just a failed attempt.
  }

  if (!checkPassword(password)) {
    recordFailure(key, now);
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }

  attempts.delete(key);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    SESSION_COOKIE,
    issueSession(now),
    sessionCookieOptions(requestIsHttps(req.headers, req.url)),
  );
  return res;
}
