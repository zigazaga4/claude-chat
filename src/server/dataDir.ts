import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * App data directory shared by the database and the secrets key.
 *
 * New installs use ~/.claude-chat. If a legacy ~/.cloudchat directory
 * already exists (pre-rename installs), keep using it so existing
 * databases and encryption keys remain valid without migration.
 */
export function dataDir(): string {
  const current = path.join(os.homedir(), '.claude-chat');
  const legacy = path.join(os.homedir(), '.cloudchat');
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  fs.mkdirSync(current, { recursive: true });
  return current;
}
