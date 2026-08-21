import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChatMessage, ContentBlock, ImageAttachmentBlock } from '@/lib/types';
import { isSshCwd } from '@/lib/cwd';
import { DEFAULT_BACKEND, isValidBackend, type ChatBackend } from '@/lib/backends';
import { getDb } from './db';
import { setWorkspaceLastConversation } from './workspaces';

export type ConversationRow = {
  id: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  source: 'claude-chat' | 'sdk';
  /** Where the conversation was created: a local folder or an SSH remote. */
  origin: 'local' | 'ssh';
  /** Harness that owns this conversation. Fixed at creation. */
  backend: ChatBackend;
};

export type StoredMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  seq: number;
  createdAt: number;
  blocks: ContentBlock[];
  text?: string;
};

function encodeCwdToProjectFolder(cwd: string): string {
  const trimmed = cwd.replace(/\/$/, '');
  return trimmed.replace(/\//g, '-');
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Absolute path of the CLI's transcript for a session. The CLI derives the
 * folder from the cwd it was launched with, so callers must pass the same
 * `sdkCwd` the SDK was given (the local home dir for SSH workspaces), not the
 * workspace cwd shown in the UI.
 */
export function sdkTranscriptPath(sdkCwd: string, sessionId: string): string {
  return path.join(
    projectsRoot(),
    encodeCwdToProjectFolder(sdkCwd),
    `${sessionId}.jsonl`,
  );
}

function listSdkSessions(cwd: string): { id: string; mtime: number; ctime: number }[] {
  const folder = path.join(projectsRoot(), encodeCwdToProjectFolder(cwd));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { id: string; mtime: number; ctime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    const id = entry.name.slice(0, -'.jsonl'.length);
    if (!id) continue;
    try {
      const stat = fs.statSync(path.join(folder, entry.name));
      out.push({ id, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function ensureConversation(
  id: string,
  cwd: string,
  now: number,
  opts?: { ephemeral?: boolean; backend?: ChatBackend },
): void {
  const db = getDb();
  // Tag SSH conversations at creation time — their SDK transcripts land in
  // the LOCAL ~/.claude/projects folder (the SDK needs a real local cwd), so
  // the tag is the only reliable way to keep them out of local listings.
  const origin = isSshCwd(cwd) ? 'ssh' : 'local';
  const ephemeral = opts?.ephemeral === true;
  const backend = opts?.backend ?? DEFAULT_BACKEND;
  // Neither `ephemeral` nor `backend` is touched by the conflict branch. Both
  // are set once at creation — `ephemeral` is cleared only by
  // `keepConversation`, and `backend` is never changed at all, because the
  // engine that owns a conversation's session store cannot change under it.
  // Callers that re-ensure an existing row (resume, message paging) don't know
  // either value and must not overwrite them.
  db.prepare(
    `INSERT INTO conversations (id, cwd, title, created_at, updated_at, origin, ephemeral, backend)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, origin = excluded.origin, updated_at = excluded.updated_at`,
  ).run(id, cwd, now, now, origin, ephemeral ? 1 : 0, backend);
  // A throwaway never becomes the workspace's "last conversation" — it would
  // surface in the sidebar as the thing to resume, which is the opposite of
  // what it is for.
  if (!ephemeral) setWorkspaceLastConversation(cwd, id, now);
}

/**
 * Backend that owns a conversation, or null if it does not exist yet.
 *
 * This is what makes the choice binding: `/api/chat` reads it before every
 * turn on an existing conversation and ignores whatever the client asked for.
 * A stale client that still thinks it is on the other engine cannot pull the
 * conversation across.
 */
export function getConversationBackend(id: string): ChatBackend | null {
  const row = getDb()
    .prepare<[string], { backend: string }>(
      `SELECT backend FROM conversations WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  // Rows written before the column existed read as the default, which is
  // correct: everything that pre-dates it was run by the Agent SDK.
  return isValidBackend(row.backend) ? row.backend : DEFAULT_BACKEND;
}

/**
 * Promote a throwaway conversation into a normal, saved one ("Keep"). Also
 * makes it the workspace's last conversation, since the user just said they
 * want it. No-op for ids that were never ephemeral.
 */
export function keepConversation(id: string): boolean {
  const db = getDb();
  const row = db
    .prepare<[string], { cwd: string; updated_at: number }>(
      `SELECT cwd, updated_at FROM conversations WHERE id = ? AND ephemeral = 1`,
    )
    .get(id);
  if (!row) return false;
  db.prepare(`UPDATE conversations SET ephemeral = 0 WHERE id = ?`).run(id);
  setWorkspaceLastConversation(row.cwd, id, row.updated_at);
  return true;
}

/**
 * Delete a conversation for good: the DB row (messages + notebook cascade)
 * and the CLI transcript that backs it, so a discarded throwaway can't come
 * back as an "external" session in the picker.
 */
export function deleteConversation(id: string): boolean {
  const db = getDb();
  const row = db
    .prepare<[string], { cwd: string; origin: string }>(
      `SELECT cwd, origin FROM conversations WHERE id = ?`,
    )
    .get(id);
  const info = db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  if (row) {
    // SSH conversations run the SDK against a local placeholder cwd (home),
    // so that — not the ssh:// workspace — is where their transcript lives.
    const sdkCwd = row.origin === 'ssh' || isSshCwd(row.cwd) ? os.homedir() : row.cwd;
    try {
      fs.rmSync(sdkTranscriptPath(sdkCwd, id), { force: true });
    } catch {
      /* transcript already gone or unreadable — the row is what matters */
    }
  }
  return info.changes > 0;
}

/**
 * Throwaways untouched this long are swept.
 *
 * Thirty days, not a day. The client no longer deletes its own throwaways on
 * navigation, so this is the only thing that removes them — which makes it a
 * backstop against unbounded growth, not a retention policy. At 24 hours it
 * silently ate any throwaway the user left over a weekend, which is exactly
 * the "it did not survive a restart" complaint.
 */
export const EPHEMERAL_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Reap throwaway conversations nothing came back for — a crash, a closed
 * browser, a tab abandoned a month ago. Anything the user is still returning
 * to keeps getting its `updated_at` bumped and is never eligible.
 */
export function sweepEphemeralConversations(maxAgeMs = EPHEMERAL_MAX_AGE_MS): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  const stale = db
    .prepare<[number], { id: string }>(
      `SELECT id FROM conversations WHERE ephemeral = 1 AND updated_at < ?`,
    )
    .all(cutoff);
  for (const row of stale) deleteConversation(row.id);
  return stale.length;
}

export function setConversationTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL`).run(title, id);
}

export function touchConversation(id: string, now: number): void {
  const db = getDb();
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, id);
}

export function nextMessageSeq(conversationId: string): number {
  const db = getDb();
  const row = db
    .prepare<[string], { max: number | null }>(
      `SELECT MAX(seq) as max FROM messages WHERE conversation_id = ?`,
    )
    .get(conversationId);
  return ((row?.max ?? -1) as number) + 1;
}

export function upsertMessage(
  message: {
    id: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    seq: number;
    createdAt: number;
    blocks: ContentBlock[];
  },
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, seq, created_at, blocks_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET blocks_json = excluded.blocks_json`,
  ).run(
    message.id,
    message.conversationId,
    message.role,
    message.seq,
    message.createdAt,
    JSON.stringify(message.blocks),
  );
}

export function listConversationsForCwd(cwd: string): ConversationRow[] {
  const db = getDb();
  type LocalRow = {
    id: string;
    cwd: string;
    title: string | null;
    created_at: number;
    updated_at: number;
    msg_count: number;
    origin: 'local' | 'ssh';
    backend: string;
  };
  const localRows = db
    .prepare<[string], LocalRow>(
      `SELECT c.id, c.cwd, c.title, c.created_at, c.updated_at, c.origin, c.backend,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as msg_count
         FROM conversations c
        WHERE c.cwd = ? AND c.ephemeral = 0
        ORDER BY c.updated_at DESC`,
    )
    .all(cwd);
  const localById = new Map(localRows.map((r) => [r.id, r]));

  const sdkSessions = listSdkSessions(cwd);

  // SDK transcripts found in this cwd's projects folder can belong to a
  // DIFFERENT workspace — most notably SSH conversations, which run the SDK
  // with a local placeholder cwd (the user's home) and therefore drop their
  // JSONL files right into the home workspace's folder. Any session id the
  // DB has registered to another cwd (or tagged ssh) is theirs, not ours.
  // Throwaways are hidden for a different reason — they're ours, they're just
  // not meant to be listed — but the effect on this merge is identical.
  const hiddenSdkIds = new Set<string>();
  {
    const foreignIds = sdkSessions
      .map((s) => s.id)
      .filter((id) => !localById.has(id));
    if (foreignIds.length > 0) {
      const placeholders = foreignIds.map(() => '?').join(',');
      const rows = db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM conversations
            WHERE id IN (${placeholders})
              AND (cwd <> ? OR origin = 'ssh' OR ephemeral = 1)`,
        )
        .all(...foreignIds, cwd);
      for (const r of rows) hiddenSdkIds.add(r.id);
    }
  }

  const merged = new Map<string, ConversationRow>();

  for (const local of localRows) {
    merged.set(local.id, {
      id: local.id,
      cwd: local.cwd,
      title: local.title,
      createdAt: local.created_at,
      updatedAt: local.updated_at,
      messageCount: local.msg_count,
      source: 'claude-chat',
      origin: local.origin === 'ssh' ? 'ssh' : 'local',
      backend: isValidBackend(local.backend) ? local.backend : DEFAULT_BACKEND,
    });
  }

  for (const sdk of sdkSessions) {
    if (hiddenSdkIds.has(sdk.id)) continue;
    const local = localById.get(sdk.id);
    if (local) {
      const existing = merged.get(sdk.id);
      if (existing && sdk.mtime > existing.updatedAt) {
        existing.updatedAt = sdk.mtime;
      }
      continue;
    }
    merged.set(sdk.id, {
      id: sdk.id,
      cwd,
      title: null,
      createdAt: Math.floor(sdk.ctime),
      updatedAt: Math.floor(sdk.mtime),
      messageCount: 0,
      source: 'sdk',
      origin: 'local',
      // Discovered straight from a Claude Code CLI transcript folder, so it is
      // an Agent SDK conversation by definition.
      backend: 'sdk',
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

type MessageRow = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  seq: number;
  created_at: number;
  blocks_json: string;
};

function rowToChatMessage(row: MessageRow): ChatMessage {
  let blocks: ContentBlock[] = [];
  try {
    blocks = JSON.parse(row.blocks_json) as ContentBlock[];
  } catch {
    blocks = [];
  }
  // Anything we hydrate from disk is finalized — clear streaming flags so a
  // mid-stream crash doesn't leave a forever-pending tool/text/thinking
  // block in the UI.
  blocks = blocks.map((b) => {
    if (b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use') {
      return { ...b, streaming: false } as ContentBlock;
    }
    return b;
  });
  if (row.role === 'user') {
    const text = blocks
      .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .filter(Boolean)
      .join('\n');
    const images = blocks.filter(
      (b): b is ImageAttachmentBlock => b.type === 'image',
    );
    return {
      id: row.id,
      role: 'user',
      text,
      images: images.length > 0 ? images : undefined,
      createdAt: row.created_at,
    };
  }
  if (row.role === 'system') {
    return { id: row.id, role: 'system', blocks, createdAt: row.created_at };
  }
  return { id: row.id, role: 'assistant', blocks, createdAt: row.created_at };
}

export type MessagePage = {
  messages: ChatMessage[];
  oldestSeq: number | null;
  hasMoreOlder: boolean;
};

export function getMessagesPage(
  conversationId: string,
  limit: number,
  beforeSeq?: number,
): MessagePage {
  const db = getDb();
  const cap = Math.max(1, Math.min(limit, 200));
  const fetchLimit = cap + 1;

  const rows =
    beforeSeq != null
      ? db
          .prepare<[string, number, number], MessageRow>(
            `SELECT id, role, seq, created_at, blocks_json
               FROM messages
              WHERE conversation_id = ? AND seq < ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(conversationId, beforeSeq, fetchLimit)
      : db
          .prepare<[string, number], MessageRow>(
            `SELECT id, role, seq, created_at, blocks_json
               FROM messages
              WHERE conversation_id = ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(conversationId, fetchLimit);

  const hasMoreOlder = rows.length > cap;
  const trimmed = (hasMoreOlder ? rows.slice(0, cap) : rows).reverse();
  const messages = trimmed.map(rowToChatMessage);
  const oldestSeq = trimmed.length > 0 ? trimmed[0].seq : null;
  return { messages, oldestSeq, hasMoreOlder };
}

export function getMessagesForConversation(conversationId: string): ChatMessage[] {
  return getMessagesPage(conversationId, 200).messages;
}
