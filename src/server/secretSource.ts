/**
 * How a user-supplied secret is configured: environment variable first, file
 * beside the database second.
 *
 * The file is not a fallback nicety, it is the reliable path. `next start` in
 * this project does **not** load `.env.local` into `process.env` — verified by
 * booting the built server with the ambient variables stripped and watching the
 * auth gate report no password at all. The provider keys appear to work only
 * because they are *also* exported from the shell pm2 inherits. So an env-only
 * design fails the first time it runs somewhere those exports are missing,
 * which on macOS is every boot: `pm2 startup` installs a launchd job, and
 * launchd does not read ~/.zshrc.
 *
 * Extracted from auth.ts once a second consumer appeared. The per-name cache is
 * the reason it matters: auth.ts held a single module-level slot, which is
 * correct for exactly one secret and silently hands back the wrong value the
 * moment there are two.
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';

/**
 * Re-read at most this often. Callers consult these on every request, so this
 * must not be a disk hit each time — but a change should still take effect
 * without a restart.
 */
const DEFAULT_TTL_MS = 5000;

const cache = new Map<string, { value: string; readAt: number }>();

/**
 * The configured value, or `''` when it is set nowhere.
 *
 * Empty is deliberately not an error: every caller decides for itself what an
 * absent secret means, and both of them fail closed rather than guessing.
 */
export function readConfiguredSecret(opts: {
  /** Environment variable checked first. */
  envVar: string;
  /** File name inside the data directory, used when the variable is unset. */
  fileName: string;
  ttlMs?: number;
}): string {
  const fromEnv = process.env[opts.envVar]?.trim();
  if (fromEnv) return fromEnv;

  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const hit = cache.get(opts.fileName);
  if (hit && now - hit.readAt < ttl) return hit.value;

  let value = '';
  try {
    value = fs.readFileSync(path.join(dataDir(), opts.fileName), 'utf8').trim();
  } catch {
    // Not configured anywhere. Left as '' for the caller to reject.
  }
  cache.set(opts.fileName, { value, readAt: now });
  return value;
}
