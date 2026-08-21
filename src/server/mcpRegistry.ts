/**
 * Registry of third-party MCP servers, in two layers.
 *
 * **Definitions are global.** One library of "how to reach this server",
 * shared by every workspace — so a server set up once while working on an SSH
 * host is still there tomorrow from a local folder.
 *
 * **Attachments are per folder.** Which servers are actually live is a
 * property of the WORKSPACE, not the conversation: the folder holding an
 * Unreal project gets the Unreal server, the folder holding a Python script
 * gets a different set, and every conversation opened in a folder inherits
 * that folder's set. Attaching is cheap and reversible; the definition
 * survives detaching.
 *
 * The two layers meet in `hostRef`. A definition with `hostRef: null` runs on
 * whichever host the attached workspace lives on — attach it to folders on
 * two different SSH hosts and it runs on each, from one definition. Pin
 * `hostRef` to an `ssh://` workspace instead and it always runs there, no
 * matter which folder it is attached to.
 *
 * The built-in servers (notebook, remote, vision) are code; everything here is
 * DATA — added at runtime by the user through the management UI or, more
 * often, by the agent itself via the `mcp` tools (see mcpConnector.ts). That
 * is the point: an agent already working over SSH can install an MCP on the
 * host with the remote shell, then wire it into the harness in the same turn.
 *
 * Storage follows the workspaces pattern: better-sqlite3 rows in the app DB,
 * with the two secret-bearing columns (env vars, HTTP headers) encrypted at
 * rest exactly like stored SSH passwords. Names are the tool namespace the
 * engines will show (`mcp__<name>__<tool>`), so they are validated hard:
 * short, identifier-like, and never one the built-ins already claim.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { decryptSecret, encryptSecret } from './secrets';

/** How to reach the MCP server. stdio spawns a process; http speaks the wire protocol. */
export type McpTransport = 'local-stdio' | 'ssh-stdio' | 'http';

export type McpServerEntry = {
  id: string;
  /** Tool namespace. `mcp__<name>__<tool>` on the SDK backend, `<name>_<tool>` on OpenCode. */
  name: string;
  transport: McpTransport;
  /**
   * Local: command line, shell-split with basic quote handling (`uvx blender-mcp`).
   * SSH: the full remote shell line (`npx -y mcp-server-foo` or a PowerShell
   * invocation on Windows hosts) — executed verbatim on the host.
   */
  command: string | null;
  /** `http` transport only. */
  url: string | null;
  /** `http` transport only. Encrypted at rest; never echoed back to the model. */
  headers: Record<string, string>;
  /** Env vars for the spawned process. Encrypted at rest; never echoed back. */
  env: Record<string, string>;
  /**
   * Where an `ssh-stdio` entry runs.
   *
   * An `ssh://…` workspace cwd PINS it to that host. `null` means "follow the
   * workspace" — the server runs on whichever host the folder it is attached
   * to lives on, which is what lets one definition serve several machines.
   * Either way the host is reached through the same workspace/credential
   * machinery as the remote tools, so pooled connections, key auth, and
   * host-key pinning all apply.
   */
  hostRef: string | null;
  /** Global kill switch for the definition, independent of attachments. */
  enabled: boolean;
  /** Last connection outcome, for listings. Free-form, includes failures. */
  status: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Names the harness itself owns — a registry entry may never shadow them. */
export const RESERVED_MCP_NAMES = new Set(['notebook', 'remote', 'vision', 'mcp']);

export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function isValidMcpName(name: string): boolean {
  return MCP_NAME_PATTERN.test(name) && !RESERVED_MCP_NAMES.has(name);
}

type Row = {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  headers_json: string | null;
  env_json: string | null;
  host_ref: string | null;
  enabled: number;
  status: string | null;
  created_at: number;
  updated_at: number;
};

function toEntry(row: Row): McpServerEntry {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command,
    url: row.url,
    headers: decryptJson(row.headers_json),
    env: decryptJson(row.env_json),
    hostRef: row.host_ref,
    enabled: row.enabled !== 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decryptJson(encoded: string | null): Record<string, string> {
  if (!encoded) return {};
  const raw = decryptSecret(encoded);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A definition with its host resolved against the workspace using it.
 *
 * Everything downstream of resolution (the pool, the proxy) works with this
 * rather than the raw entry, because the same definition can be live on two
 * hosts at once and those are two different connections.
 */
export type ResolvedMcpEntry = McpServerEntry & {
  /** Concrete host, after applying the follow-the-workspace rule. */
  hostRef: string | null;
  /** Pool identity: one live connection per (definition, host). */
  poolKey: string;
};

/**
 * Bind a definition to the workspace that is using it.
 *
 * A pinned `hostRef` wins. Otherwise an `ssh://` workspace lends its own host,
 * and a local workspace lends none — which is exactly right for `local-stdio`
 * and `http`, and an error `ssh-stdio` will report clearly at connect time.
 */
export function resolveForWorkspace(
  entry: McpServerEntry,
  workspaceCwd: string | null,
): ResolvedMcpEntry {
  const fromWorkspace =
    workspaceCwd && workspaceCwd.startsWith('ssh://') ? workspaceCwd : null;
  const hostRef = entry.hostRef ?? fromWorkspace;
  return { ...entry, hostRef, poolKey: `${entry.id}::${hostRef ?? 'local'}` };
}

/** Everything that defines HOW to connect — used to detect config drift in the pool. */
export function entryFingerprint(entry: McpServerEntry): string {
  return JSON.stringify([
    entry.transport,
    entry.command,
    entry.url,
    entry.headers,
    entry.env,
    entry.hostRef,
  ]);
}

export type UpsertMcpServer = {
  name: string;
  transport: McpTransport;
  command?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  hostRef?: string | null;
  enabled?: boolean;
};

/**
 * Create or update by name. Updating an existing entry keeps its id, so pool
 * entries keyed by id are re-fingerprinted (and reconnected) on config change.
 */
export function upsertMcpServer(input: UpsertMcpServer): McpServerEntry {
  if (!isValidMcpName(input.name)) {
    throw new Error(
      `Invalid MCP server name "${input.name}": use letters/digits/dashes/underscores ` +
        `(max 32 chars), and not one of: ${[...RESERVED_MCP_NAMES].join(', ')}.`,
    );
  }
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO mcp_servers (
       id, name, transport, command, url, headers_json, env_json,
       host_ref, enabled, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       transport   = excluded.transport,
       command     = excluded.command,
       url         = excluded.url,
       headers_json = excluded.headers_json,
       env_json    = excluded.env_json,
       host_ref    = excluded.host_ref,
       enabled     = excluded.enabled,
       status      = 'pending',
       updated_at  = excluded.updated_at`,
  ).run(
    randomUUID(),
    input.name,
    input.transport,
    input.command ?? null,
    input.url ?? null,
    encryptSecret(JSON.stringify(input.headers ?? {})),
    encryptSecret(JSON.stringify(input.env ?? {})),
    input.hostRef ?? null,
    (input.enabled ?? true) ? 1 : 0,
    now,
    now,
  );
  return getMcpServer(input.name)!;
}

export function getMcpServer(name: string): McpServerEntry | null {
  const row = getDb()
    .prepare<[string], Row>(`SELECT * FROM mcp_servers WHERE name = ?`)
    .get(name);
  return row ? toEntry(row) : null;
}

export function getMcpServerById(id: string): McpServerEntry | null {
  const row = getDb()
    .prepare<[string], Row>(`SELECT * FROM mcp_servers WHERE id = ?`)
    .get(id);
  return row ? toEntry(row) : null;
}

/** The whole global library, or only definitions not globally disabled. */
export function listMcpServers(enabledOnly = false): McpServerEntry[] {
  const rows = enabledOnly
    ? getDb()
        .prepare<[], Row>(`SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name`)
        .all()
    : getDb().prepare<[], Row>(`SELECT * FROM mcp_servers ORDER BY name`).all();
  return rows.map(toEntry);
}

/**
 * Definitions live in one folder, host already resolved — what a turn in that
 * workspace actually attaches.
 *
 * Both `enabled` flags must be on: the per-folder one (this server is wanted
 * here) and the global one (this definition is usable at all).
 */
export function listServersForWorkspace(
  workspaceCwd: string,
): ResolvedMcpEntry[] {
  const rows = getDb()
    .prepare<[string], Row>(
      `SELECT s.* FROM mcp_servers s
         JOIN mcp_workspace_servers a ON a.server_id = s.id
        WHERE a.cwd = ? AND a.enabled = 1 AND s.enabled = 1
        ORDER BY s.name`,
    )
    .all(workspaceCwd);
  return rows.map((r) => resolveForWorkspace(toEntry(r), workspaceCwd));
}

/** Ids of the definitions attached to a folder, whatever their enabled state. */
export function listAttachmentsForWorkspace(
  workspaceCwd: string,
): { serverId: string; enabled: boolean }[] {
  return getDb()
    .prepare<[string], { server_id: string; enabled: number }>(
      `SELECT server_id, enabled FROM mcp_workspace_servers WHERE cwd = ?`,
    )
    .all(workspaceCwd)
    .map((r) => ({ serverId: r.server_id, enabled: r.enabled !== 0 }));
}

/** Make a definition live in a folder. Idempotent; re-enables a disabled row. */
export function attachToWorkspace(workspaceCwd: string, serverId: string): void {
  getDb()
    .prepare(
      `INSERT INTO mcp_workspace_servers (cwd, server_id, enabled, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(cwd, server_id) DO UPDATE SET enabled = 1`,
    )
    .run(workspaceCwd, serverId, Date.now());
}

/** Remove a definition from a folder. The definition itself survives. */
export function detachFromWorkspace(
  workspaceCwd: string,
  serverId: string,
): boolean {
  const res = getDb()
    .prepare(`DELETE FROM mcp_workspace_servers WHERE cwd = ? AND server_id = ?`)
    .run(workspaceCwd, serverId);
  return res.changes > 0;
}

/** Folders a definition is currently attached to — shown before deleting it. */
export function listWorkspacesForServer(serverId: string): string[] {
  return getDb()
    .prepare<[string], { cwd: string }>(
      `SELECT cwd FROM mcp_workspace_servers WHERE server_id = ? ORDER BY cwd`,
    )
    .all(serverId)
    .map((r) => r.cwd);
}

export function deleteMcpServer(name: string): boolean {
  const res = getDb()
    .prepare(`DELETE FROM mcp_servers WHERE name = ?`)
    .run(name);
  return res.changes > 0;
}

/** Record a connection outcome for listings. Never throws. */
export function setMcpStatus(name: string, status: string): void {
  try {
    getDb()
      .prepare(
        `UPDATE mcp_servers SET status = ?, updated_at = ? WHERE name = ?`,
      )
      .run(status.slice(0, 500), Date.now(), name);
  } catch {
    // Status is advisory; a failed write must never break a connection path.
  }
}
