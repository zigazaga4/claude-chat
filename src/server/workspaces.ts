import { getDb } from './db';
import { decryptSecret, encryptSecret } from './secrets';

export type WorkspaceRow = {
  cwd: string;
  firstUsed: number;
  lastUsed: number;
  conversationCount: number;
  lastConversation: {
    id: string;
    title: string | null;
    updatedAt: number;
  } | null;
  kind: 'local' | 'ssh';
  sshIdentityPath: string | null;
  sshUseAgent: boolean;
  sshKnownHostFp: string | null;
  /** True if a password is on file for this workspace. We never expose the value. */
  hasStoredPassword: boolean;
};

export type SshUpsertOpts = {
  cwd: string;
  identityPath?: string | null;
  useAgent?: boolean;
  knownHostFingerprint?: string | null;
  /** Plaintext password to remember (will be encrypted at rest). */
  rememberPassword?: string;
  /** Explicitly clear any stored password. */
  forgetPassword?: boolean;
};

export function upsertSshWorkspace(opts: SshUpsertOpts): void {
  const db = getDb();
  const now = Date.now();
  let pwExpr = 'workspaces.ssh_password_encrypted';
  let pwValue: string | null = null;
  if (opts.forgetPassword) {
    pwExpr = 'NULL';
  } else if (opts.rememberPassword) {
    pwValue = encryptSecret(opts.rememberPassword);
    pwExpr = '?';
  }

  // Insert path always supplies a value for the password column (NULL by default)
  db.prepare(
    `INSERT INTO workspaces (
       cwd, first_used, last_used,
       kind, ssh_identity_path, ssh_use_agent, ssh_known_host_fp, ssh_password_encrypted
     ) VALUES (?, ?, ?, 'ssh', ?, ?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET
       last_used               = excluded.last_used,
       kind                    = 'ssh',
       ssh_identity_path       = excluded.ssh_identity_path,
       ssh_use_agent           = excluded.ssh_use_agent,
       ssh_known_host_fp       = COALESCE(excluded.ssh_known_host_fp, workspaces.ssh_known_host_fp),
       ssh_password_encrypted  = ${pwExpr}`,
  ).run(
    opts.cwd,
    now,
    now,
    opts.identityPath ?? null,
    opts.useAgent ? 1 : 0,
    opts.knownHostFingerprint ?? null,
    pwValue,
    ...(pwExpr === '?' ? [pwValue] : []),
  );
}

/** Returns the stored plaintext password for an SSH workspace, or null. */
export function getStoredSshPassword(cwd: string): string | null {
  const db = getDb();
  const row = db
    .prepare<[string], { ssh_password_encrypted: string | null }>(
      `SELECT ssh_password_encrypted FROM workspaces WHERE cwd = ?`,
    )
    .get(cwd);
  if (!row || !row.ssh_password_encrypted) return null;
  return decryptSecret(row.ssh_password_encrypted);
}

export function clearStoredSshPassword(cwd: string): void {
  const db = getDb();
  db.prepare(`UPDATE workspaces SET ssh_password_encrypted = NULL WHERE cwd = ?`).run(cwd);
}

export function getWorkspace(cwd: string): WorkspaceRow | null {
  const db = getDb();
  const row = db
    .prepare<[string], WorkspaceDbRow>(
      `SELECT
         w.cwd, w.first_used, w.last_used, w.last_conversation_id,
         w.kind, w.ssh_identity_path, w.ssh_use_agent, w.ssh_known_host_fp, w.ssh_password_encrypted,
         (SELECT COUNT(*) FROM conversations c WHERE c.cwd = w.cwd) AS conversation_count,
         lc.id          AS last_conv_id,
         lc.title       AS last_conv_title,
         lc.updated_at  AS last_conv_updated_at
       FROM workspaces w
       LEFT JOIN conversations lc ON lc.id = w.last_conversation_id
       WHERE w.cwd = ?`,
    )
    .get(cwd);
  if (!row) return null;
  return rowToWorkspace(row);
}

type WorkspaceDbRow = {
  cwd: string;
  first_used: number;
  last_used: number;
  last_conversation_id: string | null;
  kind: string;
  ssh_identity_path: string | null;
  ssh_use_agent: number;
  ssh_known_host_fp: string | null;
  ssh_password_encrypted: string | null;
  conversation_count: number;
  last_conv_id: string | null;
  last_conv_title: string | null;
  last_conv_updated_at: number | null;
};

function rowToWorkspace(r: WorkspaceDbRow): WorkspaceRow {
  return {
    cwd: r.cwd,
    firstUsed: r.first_used,
    lastUsed: r.last_used,
    conversationCount: r.conversation_count,
    lastConversation: r.last_conv_id
      ? {
          id: r.last_conv_id,
          title: r.last_conv_title,
          updatedAt: r.last_conv_updated_at ?? r.last_used,
        }
      : null,
    kind: r.kind === 'ssh' ? 'ssh' : 'local',
    sshIdentityPath: r.ssh_identity_path,
    sshUseAgent: !!r.ssh_use_agent,
    sshKnownHostFp: r.ssh_known_host_fp,
    hasStoredPassword: !!r.ssh_password_encrypted,
  };
}

/** Insert or refresh the `last_used` timestamp for a workspace. */
export function touchWorkspace(cwd: string, now: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (cwd, first_used, last_used)
     VALUES (?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET last_used = excluded.last_used`,
  ).run(cwd, now, now);
}

/** Record which conversation was most recently opened for this workspace. */
export function setWorkspaceLastConversation(
  cwd: string,
  conversationId: string,
  now: number,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (cwd, first_used, last_used, last_conversation_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET
       last_used = excluded.last_used,
       last_conversation_id = excluded.last_conversation_id`,
  ).run(cwd, now, now, conversationId);
}

export function listWorkspaces(): WorkspaceRow[] {
  const db = getDb();
  const rows = db
    .prepare<[], WorkspaceDbRow>(
      `SELECT
         w.cwd,
         w.first_used,
         w.last_used,
         w.last_conversation_id,
         w.kind,
         w.ssh_identity_path,
         w.ssh_use_agent,
         w.ssh_known_host_fp,
         w.ssh_password_encrypted,
         (SELECT COUNT(*) FROM conversations c WHERE c.cwd = w.cwd) AS conversation_count,
         lc.id          AS last_conv_id,
         lc.title       AS last_conv_title,
         lc.updated_at  AS last_conv_updated_at
       FROM workspaces w
       LEFT JOIN conversations lc
         ON lc.id = w.last_conversation_id
       ORDER BY w.last_used DESC`,
    )
    .all();

  return rows.map(rowToWorkspace);
}

export function deleteWorkspace(cwd: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM workspaces WHERE cwd = ?`).run(cwd);
}
