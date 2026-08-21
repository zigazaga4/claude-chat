import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Database file names this app has shipped, across the rename. */
const DB_NAMES = ['claude-chat.db', 'cloudchat.db'];

function hasDatabase(dir: string): boolean {
  return DB_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * App data directory shared by the database, the secrets key, and the
 * password file.
 *
 * New installs use ~/.claude-chat. If a legacy ~/.cloudchat install already
 * holds the database, keep using it so existing conversations, workspaces and
 * encrypted credentials stay reachable without a migration.
 *
 * The choice keys off the presence of a **database**, not of the directory.
 * It used to test the directory, which meant anything that merely stored a
 * file next to the database — a key, a password — created ~/.claude-chat as a
 * side effect and silently repointed the entire app at an empty database on
 * the next restart. That is not a hypothetical: writing the password file did
 * exactly that, and 165 conversations appeared to vanish until the directory
 * was moved back out of the way. A sibling file must never be able to decide
 * which database is live.
 */
export function dataDir(): string {
  const current = path.join(os.homedir(), '.claude-chat');
  const legacy = path.join(os.homedir(), '.cloudchat');
  if (!hasDatabase(current) && hasDatabase(legacy)) return legacy;
  fs.mkdirSync(current, { recursive: true });
  return current;
}
