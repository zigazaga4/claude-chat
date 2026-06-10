import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChatMessage, ContentBlock, ImageAttachmentBlock } from '@/lib/types';
import { isSshCwd } from '@/lib/cwd';
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

export function ensureConversation(id: string, cwd: string, now: number): void {
  const db = getDb();
  // Tag SSH conversations at creation time — their SDK transcripts land in
  // the LOCAL ~/.claude/projects folder (the SDK needs a real local cwd), so
  // the tag is the only reliable way to keep them out of local listings.
  const origin = isSshCwd(cwd) ? 'ssh' : 'local';
  db.prepare(
    `INSERT INTO conversations (id, cwd, title, created_at, updated_at, origin)
     VALUES (?, ?, NULL, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, origin = excluded.origin, updated_at = excluded.updated_at`,
  ).run(id, cwd, now, now, origin);
  setWorkspaceLastConversation(cwd, id, now);
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
  };
  const localRows = db
    .prepare<[string], LocalRow>(
      `SELECT c.id, c.cwd, c.title, c.created_at, c.updated_at, c.origin,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as msg_count
         FROM conversations c
        WHERE c.cwd = ?
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
  const claimedElsewhere = new Set<string>();
  {
    const foreignIds = sdkSessions
      .map((s) => s.id)
      .filter((id) => !localById.has(id));
    if (foreignIds.length > 0) {
      const placeholders = foreignIds.map(() => '?').join(',');
      const rows = db
        .prepare<unknown[], { id: string }>(
          `SELECT id FROM conversations
            WHERE id IN (${placeholders}) AND (cwd <> ? OR origin = 'ssh')`,
        )
        .all(...foreignIds, cwd);
      for (const r of rows) claimedElsewhere.add(r.id);
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
    });
  }

  for (const sdk of sdkSessions) {
    if (claimedElsewhere.has(sdk.id)) continue;
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
