/**
 * Random keys persisted next to the database, outside the SQLite file.
 *
 * Both the credential-encryption key and the session-signing key want the
 * same handling — read it if it is there, mint and chmod 0600 it if not,
 * and never hand back a file that is the wrong size — so that lives here
 * once rather than in each consumer.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';

const cache = new Map<string, Buffer>();

/**
 * The key stored at `~/.claude-chat/<name>`, creating it on first call.
 *
 * A file of the wrong length is treated as corrupt rather than trusted:
 * it is renamed aside (so nothing is silently destroyed) and replaced.
 */
export function loadOrCreateKey(name: string, bytes: number): Buffer {
  const cached = cache.get(name);
  if (cached) return cached;

  const p = path.join(dataDir(), name);
  try {
    const buf = fs.readFileSync(p);
    if (buf.length === bytes) {
      cache.set(name, buf);
      return buf;
    }
    fs.renameSync(p, `${p}.bad-${Date.now()}`);
  } catch {
    // Doesn't exist yet — fall through and mint one.
  }

  const fresh = randomBytes(bytes);
  fs.writeFileSync(p, fresh, { mode: 0o600 });
  cache.set(name, fresh);
  return fresh;
}
