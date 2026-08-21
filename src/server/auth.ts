/**
 * The password gate for the whole app.
 *
 * This app can spawn shells, read and write the filesystem, and SSH out to
 * other machines — all as the user running the server. Once it is reachable
 * from anything other than localhost, an unauthenticated request is a remote
 * root shell. So the rule is: everything is gated, with no exceptions carved
 * out by source IP.
 *
 * That last part matters more than it looks. `tailscale serve` terminates TLS
 * and forwards to 127.0.0.1, so every request arriving over the tailnet is
 * indistinguishable from a genuinely local one at the socket level. A
 * "trust loopback" shortcut would therefore hand a free pass to the exact
 * traffic the gate exists to check.
 *
 * The session is a signed value, not a stored one: there is no session table
 * to keep, and a server restart does not log every device out. The trade is
 * that a token cannot be revoked individually — changing APP_PASSWORD is the
 * revoke-everything lever, and it works because the password's fingerprint is
 * part of what gets signed.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';
import { loadOrCreateKey } from './keyFile';

// Re-exported so server-side callers have one place to import auth from,
// while the client keeps importing the crypto-free module directly.
export { AUTH_REQUIRED_HEADER, SESSION_COOKIE } from '@/lib/authShared';

/** Long enough that a phone logs in once and stays in. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const KEY_BYTES = 32;

function signingKey(): Buffer {
  // An explicit secret wins, so the same session survives moving the app to
  // another machine. Otherwise one is generated and kept beside the database.
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) return createHash('sha256').update(fromEnv).digest();
  return loadOrCreateKey('session.key', KEY_BYTES);
}

/** Where the password lives when it is not in the environment. */
const PASSWORD_FILE = 'app-password';

// Re-read at most this often. The gate consults the password on every request
// (the session signature is bound to it), so this must not be a disk hit each
// time — but it should still pick up a change without a restart.
const PASSWORD_TTL_MS = 5000;
let cached: { value: string; readAt: number } | null = null;

/**
 * The configured password: `APP_PASSWORD` if it is actually exported,
 * otherwise `~/.claude-chat/app-password`.
 *
 * The file is not a nicety, it is the reliable path. `next start` in this
 * project does **not** load `.env.local` into `process.env` — verified by
 * booting the built server with the ambient variables stripped and watching
 * the gate report no password at all. The other keys in that file appear to
 * work only because they are also exported from the shell, so an env-only
 * design here would have failed closed the first time it ran under pm2
 * without those exports, locking every device out.
 */
function configuredPassword(): string {
  const fromEnv = process.env.APP_PASSWORD?.trim();
  if (fromEnv) return fromEnv;

  const now = Date.now();
  if (cached && now - cached.readAt < PASSWORD_TTL_MS) return cached.value;

  let value = '';
  try {
    value = fs.readFileSync(path.join(dataDir(), PASSWORD_FILE), 'utf8').trim();
  } catch {
    // No file — treated as "no password", which fails closed.
  }
  cached = { value, readAt: now };
  return value;
}

/**
 * Whether a password has been configured at all.
 *
 * When it has not, the gate fails **closed** rather than open: an unset
 * password on a tailnet-exposed app would otherwise mean no gate at all,
 * which is the one failure mode worth being loud about.
 */
export function isPasswordConfigured(): boolean {
  return configuredPassword().length > 0;
}

/**
 * Compare in constant time. Both sides are hashed first so the comparison
 * runs over two fixed 32-byte buffers and the length of the guess leaks
 * nothing about the length of the real password.
 */
export function checkPassword(candidate: string): boolean {
  const expected = configuredPassword();
  if (!expected) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Ties a session to the password that created it, so changing APP_PASSWORD
 * invalidates every outstanding cookie without needing to rotate the key.
 */
function passwordFingerprint(): string {
  return createHash('sha256')
    .update(configuredPassword(), 'utf8')
    .digest('base64url')
    .slice(0, 16);
}

function sign(expiresAt: string): string {
  return createHmac('sha256', signingKey())
    .update(`${expiresAt}.${passwordFingerprint()}`)
    .digest('base64url');
}

/** A cookie value good until `now + SESSION_TTL_MS`. */
export function issueSession(now: number = Date.now()): string {
  const expiresAt = String(now + SESSION_TTL_MS);
  return `${expiresAt}.${sign(expiresAt)}`;
}

/** True only for a well-formed, unexpired, correctly-signed token. */
export function verifySession(
  token: string | undefined | null,
  now: number = Date.now(),
): boolean {
  if (!token || !isPasswordConfigured()) return false;

  const split = token.indexOf('.');
  if (split <= 0) return false;
  const expiresAt = token.slice(0, split);
  const provided = token.slice(split + 1);

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) return false;

  const expected = sign(expiresAt);
  // timingSafeEqual throws on a length mismatch, so screen that first. The
  // length of an HMAC is fixed and public, so this leaks nothing.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Cookie attributes. `Secure` is conditional because the app is still reached
 * over plain http on 127.0.0.1 by the Electron shell and by local dev, and a
 * Secure cookie would simply never be stored there.
 */
export function sessionCookieOptions(isHttps: boolean) {
  return {
    httpOnly: true,
    // Lax rather than Strict: /api/fs/download is a top-level GET navigation
    // from an <a href>, and Strict would strip the cookie from it.
    sameSite: 'lax' as const,
    secure: isHttps,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Whether the original client request was HTTPS, honouring the Tailscale proxy. */
export function requestIsHttps(headers: Headers, url: string): boolean {
  const forwarded = headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0].trim() === 'https';
  return url.startsWith('https://');
}
