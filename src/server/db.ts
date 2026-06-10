import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { dataDir } from './dataDir';

let dbInstance: Database.Database | null = null;

function resolveDbPath(): string {
  const override =
    process.env.CLAUDE_CHAT_DB_PATH || process.env.CLOUDCHAT_DB_PATH;
  if (override && override.trim()) return override;
  const dir = dataDir();
  // Pre-rename installs created cloudchat.db — keep using it if present.
  const legacy = path.join(dir, 'cloudchat.db');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(dir, 'claude-chat.db');
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      cwd         TEXT NOT NULL,
      title       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      origin      TEXT NOT NULL DEFAULT 'local'
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_cwd
      ON conversations(cwd, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      blocks_json     TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
      ON messages(conversation_id, seq);

    CREATE TABLE IF NOT EXISTS workspaces (
      cwd                       TEXT PRIMARY KEY,
      first_used                INTEGER NOT NULL,
      last_used                 INTEGER NOT NULL,
      last_conversation_id      TEXT,
      kind                      TEXT NOT NULL DEFAULT 'local',
      ssh_identity_path         TEXT,
      ssh_use_agent             INTEGER NOT NULL DEFAULT 0,
      ssh_known_host_fp         TEXT,
      ssh_password_encrypted    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_last_used
      ON workspaces(last_used DESC);
  `);

  // Migrate older DBs that pre-date the SSH columns. SQLite is tolerant
  // about repeated CREATE TABLE IF NOT EXISTS but will not back-fill new
  // columns onto an existing table — do it explicitly.
  for (const sql of [
    "ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'",
    'ALTER TABLE workspaces ADD COLUMN ssh_identity_path TEXT',
    'ALTER TABLE workspaces ADD COLUMN ssh_use_agent INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE workspaces ADD COLUMN ssh_known_host_fp TEXT',
    'ALTER TABLE workspaces ADD COLUMN ssh_password_encrypted TEXT',
    // Origin tag: 'local' | 'ssh'. SSH conversations run the SDK with a
    // local placeholder cwd, so their transcripts land in the local
    // ~/.claude/projects folder — the tag is how listings tell them apart
    // and keep them out of local workspaces.
    "ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — fine.
    }
  }

  // Back-fill the origin tag for conversations created before the column
  // existed — their ssh:// cwd identifies them unambiguously.
  db.exec(`UPDATE conversations SET origin = 'ssh' WHERE cwd LIKE 'ssh://%' AND origin <> 'ssh'`);

  db.exec(`
    INSERT INTO workspaces (cwd, first_used, last_used, last_conversation_id)
    SELECT
      c.cwd,
      MIN(c.created_at)                                                      AS first_used,
      MAX(c.updated_at)                                                      AS last_used,
      (SELECT id FROM conversations c2
        WHERE c2.cwd = c.cwd
        ORDER BY c2.updated_at DESC
        LIMIT 1)                                                             AS last_conversation_id
    FROM conversations c
    GROUP BY c.cwd
    ON CONFLICT(cwd) DO NOTHING;
  `);

  dbInstance = db;
  return db;
}
