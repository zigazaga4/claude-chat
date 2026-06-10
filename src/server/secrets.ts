/**
 * Light-weight encryption-at-rest for stored credentials. The key lives
 * outside the SQLite file at ~/.claude-chat/secrets.key (mode 0600) so a
 * casual copy of the database alone is not enough to read passwords.
 *
 * This is **not** a substitute for OS keyring / hardware-backed key store —
 * an attacker with full filesystem read can grab both files and decrypt.
 * It does, however, prevent passwords from sitting in plaintext on disk.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return path.join(dataDir(), 'secrets.key');
}

function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;
  const p = keyPath();
  try {
    const buf = fs.readFileSync(p);
    if (buf.length === KEY_BYTES) {
      cachedKey = buf;
      return buf;
    }
    // Key file exists but is the wrong size — back it up and regenerate.
    fs.renameSync(p, `${p}.bad-${Date.now()}`);
  } catch {
    // Doesn't exist yet.
  }
  const fresh = randomBytes(KEY_BYTES);
  fs.writeFileSync(p, fresh, { mode: 0o600 });
  cachedKey = fresh;
  return fresh;
}

/** Encrypt to "v1.<iv>.<tag>.<ciphertext>" base64-joined. */
export function encryptSecret(plaintext: string): string {
  const key = loadOrCreateKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join('.');
}

/** Returns null on any decode/decrypt failure (key rotated, corruption, etc.). */
export function decryptSecret(token: string): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const key = loadOrCreateKey();
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
