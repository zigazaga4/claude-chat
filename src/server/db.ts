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
  // better-sqlite3 is compiled with SQLITE_DEFAULT_CACHE_SIZE=-16000, i.e. a
  // 16 MB page cache per connection — eight times SQLite's own 2 MB default.
  // That is native memory, invisible to the V8 heap, and it is sized for
  // servers with room to spare rather than a 5.6 GB laptop. 4 MB still holds
  // ~1000 pages, which covers the indexes and the hot end of the message
  // table; the large reads here are single-pass history pages that blow any
  // cache regardless.
  db.pragma('cache_size = -4000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      cwd         TEXT NOT NULL,
      title       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      origin      TEXT NOT NULL DEFAULT 'local',
      ephemeral   INTEGER NOT NULL DEFAULT 0,
      backend     TEXT NOT NULL DEFAULT 'sdk'
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

    CREATE TABLE IF NOT EXISTS conversation_notes (
      conversation_id  TEXT PRIMARY KEY,
      content          TEXT NOT NULL DEFAULT '',
      updated_at       INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

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

    -- Global library of MCP server DEFINITIONS: how to reach a server, not
    -- where it is used. A NULL host_ref means "run on whichever host the
    -- workspace it is attached to lives on", so one definition can serve
    -- several SSH hosts; a non-NULL value pins it to one.
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      transport     TEXT NOT NULL,
      command       TEXT,
      url           TEXT,
      headers_json  TEXT,
      env_json      TEXT,
      host_ref      TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      status        TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- Which definitions are live in which folder. This is the per-workspace
    -- part: the game folder gets the Unreal server, the script folder gets a
    -- different set, and both draw from the same global library above.
    CREATE TABLE IF NOT EXISTS mcp_workspace_servers (
      cwd         TEXT NOT NULL,
      server_id   TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (cwd, server_id),
      FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_ws_cwd ON mcp_workspace_servers(cwd);
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
    // Throwaway ("ephemeral") conversations: hidden from every listing and
    // deleted as soon as nothing points at them. Persisted like any other
    // conversation while live so the turn loop, notebook and rehydration all
    // work unchanged — the flag only controls visibility and lifetime.
    'ALTER TABLE conversations ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0',
    // Which harness runs this conversation: 'sdk' (Claude Agent SDK, which
    // spawns the Claude Code CLI) or 'opencode'. Fixed when the conversation
    // is created and never changed afterwards — each backend keeps its own
    // session store under its own id format, so a conversation that switched
    // mid-life would hand one backend an id the other minted.
    //
    // The 'sdk' default is exactly right for back-fill: every conversation
    // that pre-dates this column was run by the Agent SDK.
    "ALTER TABLE conversations ADD COLUMN backend TEXT NOT NULL DEFAULT 'sdk'",
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
