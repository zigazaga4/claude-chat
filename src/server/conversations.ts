import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentBlock, ImageAttachmentBlock } from '@/lib/types';
import { isSshCwd } from '@/lib/cwd';
import { DEFAULT_BACKEND, isValidBackend, type ChatBackend } from '@/lib/backends';
import { getDb } from './db';
import {
  clearWorkspaceLastConversation,
  getWorkspace,
  setWorkspaceLastConversation,
} from './workspaces';

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
  /**
   * Assistant rows only: uuid of the last top-level CLI transcript entry the
   * turn produced — the point "Rewind to here" forks at. Null when unknown.
   */
  sdkUuid?: string | null;
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
 * The cwd the Agent SDK is actually launched with, which is what decides where
 * the CLI writes the transcript.
 *
 * For a local workspace it is the workspace itself. For an SSH workspace the
 * SDK still needs a real local directory to run in, so every remote
 * conversation runs against the user's home — `/api/chat` computes the same
 * thing at launch time. Both the `origin` tag and the raw cwd are consulted
 * because rows written before the tag existed can carry an `ssh://` cwd with
 * the default `local` origin.
 */
function sdkCwdFor(cwd: string, origin?: string): string {
  return origin === 'ssh' || isSshCwd(cwd) ? os.homedir() : cwd;
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
    try {
      fs.rmSync(sdkTranscriptPath(sdkCwdFor(row.cwd, row.origin), id), { force: true });
    } catch {
      /* transcript already gone or unreadable — the row is what matters */
    }
  }
  return info.changes > 0;
}

export type MoveConversationResult =
  | {
      ok: true;
      /** Workspace it came from. */
      from: string;
      /** Workspace it lives in now. */
      to: string;
      /** Whether the CLI transcript had to be relocated on disk. */
      transcriptMoved: boolean;
    }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'unknown-destination'
        | 'same-workspace'
        | 'transcript-conflict'
        | 'transcript-move-failed';
      detail?: string;
    };

/**
 * Move a conversation into another workspace — local or SSH, in any direction.
 *
 * The row is the easy half. The hard half is the CLI transcript: the Claude
 * Code CLI derives its transcript folder from the cwd it was launched with, so
 * `~/.claude/projects/<encoded sdk cwd>/<id>.jsonl` is exactly where `resume`
 * will look on the next turn. Move the row without moving that file and the
 * conversation still lists, still opens, and still shows every stored message —
 * and then the first reply comes back with no memory of any of it, because the
 * CLI quietly began a new session instead. Nothing about that failure looks
 * like a failure, which is what makes it worth this much care.
 *
 * So the file moves first and the row second. A rename that fails leaves both
 * halves where they were, which is merely a move that did not happen; a row
 * that moves ahead of a stranded transcript is a conversation that has lost its
 * mind. Ordering is the whole safety argument here.
 *
 * SSH is cheap by accident of that same asymmetry: remote conversations run the
 * SDK against the local home directory, so every `ssh://` workspace shares one
 * transcript folder and moving between two remotes touches no files at all.
 * OpenCode conversations have no transcript on this side either — OpenCode owns
 * its session store and takes the directory per prompt — so for those this is
 * purely the row, and the next turn simply runs somewhere else.
 *
 * One thing this cannot do is reach into a client that already has the
 * conversation open. `ensureConversation` re-binds the row from whatever cwd
 * the client sends, and even paging messages does it, so a stale tab elsewhere
 * will drag the conversation back the moment it is used. The caller is expected
 * to re-point its own open instances; a tab on another device is out of reach.
 */
export function moveConversation(
  id: string,
  toCwd: string,
  opts?: { fromCwd?: string },
): MoveConversationResult {
  const db = getDb();
  const row = db
    .prepare<[string], { cwd: string; origin: string }>(
      `SELECT cwd, origin FROM conversations WHERE id = ?`,
    )
    .get(id);

  // Sessions the CLI wrote directly have no row here — the picker surfaces them
  // by reading the transcript folder. They are still perfectly movable, so
  // adopt one into the database rather than dead-ending the button. The caller
  // says which workspace it was listed under; the transcript has to actually be
  // there for that claim to be worth anything.
  let adoptStat: fs.Stats | null = null;
  if (!row && opts?.fromCwd) {
    try {
      adoptStat = fs.statSync(sdkTranscriptPath(sdkCwdFor(opts.fromCwd), id));
    } catch {
      adoptStat = null;
    }
  }
  if (!row && !adoptStat) return { ok: false, reason: 'not-found' };

  const fromCwd = row ? row.cwd : (opts!.fromCwd as string);
  const fromOrigin = row ? row.origin : isSshCwd(fromCwd) ? 'ssh' : 'local';
  if (fromCwd === toCwd) return { ok: false, reason: 'same-workspace' };

  // Only somewhere cloudchat already knows about. Beyond keeping the id space
  // honest, this is what stops an unknown destination from being created here
  // as a plain local folder — `touchWorkspace` cannot tell that an `ssh://`
  // path needs `kind = 'ssh'` and the SSH credentials that go with it.
  if (!getWorkspace(toCwd)) return { ok: false, reason: 'unknown-destination' };

  const toOrigin = isSshCwd(toCwd) ? 'ssh' : 'local';
  const fromSdkCwd = sdkCwdFor(fromCwd, fromOrigin);
  const toSdkCwd = sdkCwdFor(toCwd, toOrigin);

  let transcriptMoved = false;
  let movedFrom = '';
  let movedTo = '';
  if (fromSdkCwd !== toSdkCwd) {
    const src = sdkTranscriptPath(fromSdkCwd, id);
    const dst = sdkTranscriptPath(toSdkCwd, id);
    if (fs.existsSync(src)) {
      // Session ids are UUIDs, so this is close to impossible — but a rename
      // over the top would destroy a real history, and refusing costs nothing.
      if (fs.existsSync(dst)) return { ok: false, reason: 'transcript-conflict' };
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        // Both paths sit under ~/.claude/projects, so this is a same-filesystem
        // rename: atomic, and instant even for the multi-megabyte transcripts a
        // long conversation accumulates.
        fs.renameSync(src, dst);
        transcriptMoved = true;
        movedFrom = src;
        movedTo = dst;
      } catch (e) {
        return {
          ok: false,
          reason: 'transcript-move-failed',
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  try {
    db.transaction(() => {
      if (row) {
        // `updated_at` is deliberately left alone. It orders the sidebar by
        // when the conversation was last *worked in*, and filing something
        // away is not work on it — bumping it would shove an old thread to the
        // top of its new folder.
        db.prepare(`UPDATE conversations SET cwd = ?, origin = ? WHERE id = ?`).run(
          toCwd,
          toOrigin,
          id,
        );
      } else {
        const stat = adoptStat as fs.Stats;
        // Mirrors how the picker presents an unadopted transcript: timestamps
        // from the file, no title, and the Agent SDK by definition — a Claude
        // Code transcript could not have come from anywhere else.
        db.prepare(
          `INSERT INTO conversations (id, cwd, title, created_at, updated_at, origin, ephemeral, backend)
           VALUES (?, ?, NULL, ?, ?, ?, 0, 'sdk')`,
        ).run(id, toCwd, Math.floor(stat.ctimeMs), Math.floor(stat.mtimeMs), toOrigin);
      }
      clearWorkspaceLastConversation(fromCwd, id);
    })();
  } catch (e) {
    // Put the transcript back, so a failed move is a move that did not happen
    // rather than one that half did.
    if (transcriptMoved) {
      try {
        fs.renameSync(movedTo, movedFrom);
      } catch {
        /* nothing further to try; the row is unchanged either way */
      }
    }
    return {
      ok: false,
      reason: 'transcript-move-failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  return { ok: true, from: fromCwd, to: toCwd, transcriptMoved };
}

export type ForkConversationResult =
  | {
      ok: true;
      /**
       * The new conversation. Null when there was nothing before the point to
       * keep — rewinding the very first message — so the caller should simply
       * start a fresh conversation in `cwd` with `prefill` in the composer.
       */
      conversationId: string | null;
      cwd: string;
      backend: ChatBackend;
      /** Set when rewinding to a user message: its text, to edit and resend. */
      prefill?: string;
    }
  | {
      ok: false;
      reason: 'not-found' | 'not-sdk' | 'not-rewindable' | 'fork-failed';
      detail?: string;
    };

const COPIED_ID_PREFIX: Record<string, string> = { user: 'user', assistant: 'asst', system: 'sys' };

/**
 * "Rewind to here": copy a conversation up to one of its messages into a NEW
 * conversation, leaving the original exactly as it was.
 *
 * Rewinding to an assistant message keeps everything through that answer.
 * Rewinding to a user message keeps everything before it and hands its text
 * back as `prefill`, so it can be edited and sent again — which is why its fork
 * point is the previous turn's, not its own.
 *
 * The CLI transcript is the half that matters: the new conversation id is a
 * new CLI session id, and the next turn resumes it. `forkSession` copies the
 * source transcript up to and including the turn's last chain entry under
 * fresh entry uuids, so the copy and the original can never collide. The rows
 * here are the display half, copied with fresh ids and the same seqs.
 *
 * Same ordering argument as `moveConversation`: the transcript is written
 * first and the rows second, in one transaction, and a transaction that fails
 * deletes the transcript it would have pointed at. The original conversation
 * is only ever read.
 */
export async function forkConversationAt(
  conversationId: string,
  messageId: string,
): Promise<ForkConversationResult> {
  const db = getDb();
  const conv = db
    .prepare<
      [string],
      { cwd: string; origin: string; title: string | null; backend: string }
    >(`SELECT cwd, origin, title, backend FROM conversations WHERE id = ?`)
    .get(conversationId);
  if (!conv) return { ok: false, reason: 'not-found' };
  if (conv.backend !== 'sdk') return { ok: false, reason: 'not-sdk' };

  const target = db
    .prepare<
      [string, string],
      { role: string; seq: number; blocks_json: string; sdk_uuid: string | null }
    >(
      `SELECT role, seq, blocks_json, sdk_uuid FROM messages
        WHERE id = ? AND conversation_id = ?`,
    )
    .get(messageId, conversationId);
  if (!target) return { ok: false, reason: 'not-found' };

  let upToMessageId: string;
  /** Exclusive upper bound of the seq range copied into the fork. */
  let endSeq: number;
  let prefill: string | undefined;
  if (target.role === 'assistant') {
    if (!target.sdk_uuid) return { ok: false, reason: 'not-rewindable' };
    upToMessageId = target.sdk_uuid;
    // Through this turn, plus any system rows recorded right after it — a
    // compaction during the turn persists its divider behind the answer.
    const next = db
      .prepare<[string, number], { seq: number | null }>(
        `SELECT MIN(seq) AS seq FROM messages
          WHERE conversation_id = ? AND seq > ? AND role <> 'system'`,
      )
      .get(conversationId, target.seq);
    endSeq = next?.seq ?? Number.MAX_SAFE_INTEGER;
  } else if (target.role === 'user') {
    prefill = userTextOf(parseBlocks(target.blocks_json));
    const prev = db
      .prepare<[string, number], { sdk_uuid: string | null }>(
        `SELECT sdk_uuid FROM messages
          WHERE conversation_id = ? AND role = 'assistant' AND seq < ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(conversationId, target.seq);
    // Nothing came before it, so there is nothing to copy: rewinding the
    // first message is starting over with the same text.
    if (!prev) {
      return { ok: true, conversationId: null, cwd: conv.cwd, backend: 'sdk', prefill };
    }
    if (!prev.sdk_uuid) return { ok: false, reason: 'not-rewindable' };
    upToMessageId = prev.sdk_uuid;
    endSeq = target.seq;
  } else {
    return { ok: false, reason: 'not-rewindable' };
  }

  const origin = conv.origin === 'ssh' || isSshCwd(conv.cwd) ? 'ssh' : 'local';
  const sdkCwd = sdkCwdFor(conv.cwd, origin);
  const title = conv.title ? `${conv.title} (rewind)` : 'Rewind';

  let sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  let newId: string;
  try {
    // Loaded on demand: every route that lists or pages conversations imports
    // this module, and none of them needs the SDK.
    sdk = await import('@anthropic-ai/claude-agent-sdk');
    ({ sessionId: newId } = await sdk.forkSession(conversationId, {
      dir: sdkCwd,
      upToMessageId,
      title,
    }));
  } catch (e) {
    return { ok: false, reason: 'fork-failed', detail: errorText(e) };
  }

  const copied = db
    .prepare<[string, number], { id: string; role: string; sdk_uuid: string | null }>(
      `SELECT id, role, sdk_uuid FROM messages
        WHERE conversation_id = ? AND seq < ? ORDER BY seq`,
    )
    .all(conversationId, endSeq);
  const wanted = new Set(
    copied.map((r) => r.sdk_uuid).filter((u): u is string => u != null),
  );
  // Copied rows must point at the FORK's entries — the source's uuids do not
  // exist in it. A row that cannot be mapped is stored without one, which only
  // costs the copy its own rewind button there.
  const uuidMap =
    wanted.size > 0
      ? await mapForkedUuids(sdk, conversationId, newId, sdkCwd, wanted)
      : new Map<string, string>();

  const now = Date.now();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations (id, cwd, title, created_at, updated_at, origin, ephemeral, backend)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'sdk')`,
      ).run(newId, conv.cwd, title, now, now, origin);
      // Copied in SQL so the blocks never round-trip through JS — a long
      // conversation's history is easily tens of megabytes.
      const copy = db.prepare(
        `INSERT INTO messages (id, conversation_id, role, seq, created_at, blocks_json, sdk_uuid)
         SELECT ?, ?, role, seq, created_at, blocks_json, ? FROM messages WHERE id = ?`,
      );
      for (const r of copied) {
        copy.run(
          `${COPIED_ID_PREFIX[r.role] ?? 'msg'}_${randomUUID()}`,
          newId,
          r.sdk_uuid ? (uuidMap.get(r.sdk_uuid) ?? null) : null,
          r.id,
        );
      }
      db.prepare(
        `INSERT INTO conversation_notes (conversation_id, content, updated_at)
         SELECT ?, content, ? FROM conversation_notes WHERE conversation_id = ?`,
      ).run(newId, now, conversationId);
      setWorkspaceLastConversation(conv.cwd, newId, now);
    })();
  } catch (e) {
    // No row points at the new transcript, so it must not outlive this call —
    // it would surface in the folder as an unexplained external session.
    try {
      await sdk.deleteSession(newId, { dir: sdkCwd });
    } catch {
      /* fall through to the direct unlink */
    }
    try {
      fs.rmSync(sdkTranscriptPath(sdkCwd, newId), { force: true });
    } catch {
      /* nothing further to try */
    }
    return { ok: false, reason: 'fork-failed', detail: errorText(e) };
  }

  return { ok: true, conversationId: newId, cwd: conv.cwd, backend: 'sdk', prefill };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Map source transcript uuids to their copies in a fork, for the `wanted` ones.
 *
 * First choice is the fork's own record: every entry `forkSession` writes
 * carries `forkedFrom: { sessionId, messageUuid }`, which is exact. That field
 * is not part of the SDK's typed surface, though, and the file is located with
 * this module's own path encoding, so when that yields nothing the fallback
 * matches the two chains from `getSessionMessages` by content — the fork
 * copies each entry's message verbatim. Only keys that are unique on both
 * sides are used; matching by position does not work, because the fork can
 * list parallel tool results in a different order. Anything unresolved is
 * simply left out of the map.
 */
async function mapForkedUuids(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  sourceId: string,
  forkId: string,
  sdkCwd: string,
  wanted: Set<string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const lines = readline.createInterface({
      input: fs.createReadStream(sdkTranscriptPath(sdkCwd, forkId)),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.includes('"forkedFrom"')) continue;
      try {
        const entry = JSON.parse(line) as {
          uuid?: unknown;
          forkedFrom?: { sessionId?: unknown; messageUuid?: unknown };
        };
        const from = entry.forkedFrom?.messageUuid;
        if (
          entry.forkedFrom?.sessionId === sourceId &&
          typeof from === 'string' &&
          wanted.has(from) &&
          typeof entry.uuid === 'string'
        ) {
          map.set(from, entry.uuid);
        }
      } catch {
        /* a line that does not parse cannot be mapped */
      }
    }
  } catch {
    map.clear();
  }
  if (map.size > 0) return map;

  try {
    const [source, fork] = await Promise.all([
      sdk.getSessionMessages(sourceId, { dir: sdkCwd }),
      sdk.getSessionMessages(forkId, { dir: sdkCwd }),
    ]);
    const keyOf = (m: { type: string; message: unknown }) =>
      `${m.type}\u0000${JSON.stringify(m.message)}`;
    const index = (msgs: { type: string; uuid: string; message: unknown }[]) => {
      const out = new Map<string, string | null>();
      for (const m of msgs) {
        const k = keyOf(m);
        out.set(k, out.has(k) ? null : m.uuid);
      }
      return out;
    };
    const forkByKey = index(fork);
    for (const [k, uuid] of index(source)) {
      if (uuid == null || !wanted.has(uuid)) continue;
      const copy = forkByKey.get(k);
      if (copy) map.set(uuid, copy);
    }
  } catch {
    map.clear();
  }
  return map;
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
    /**
     * Fork point for "Rewind to here" (see StoredMessage.sdkUuid). Omitting it
     * — or passing null — never clears a value already stored: most writes of
     * an assistant row happen before its turn has produced any chain entry.
     */
    sdkUuid?: string | null;
  },
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, seq, created_at, blocks_json, sdk_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       blocks_json = excluded.blocks_json,
       sdk_uuid    = COALESCE(excluded.sdk_uuid, messages.sdk_uuid)`,
  ).run(
    message.id,
    message.conversationId,
    message.role,
    message.seq,
    message.createdAt,
    JSON.stringify(message.blocks),
    message.sdkUuid ?? null,
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
  sdk_uuid: string | null;
  /**
   * User rows only: whether the nearest assistant row BEFORE this one carries
   * an sdk_uuid (1/0), or NULL when there is no earlier assistant row at all.
   */
  prev_has_uuid: number | null;
};

function parseBlocks(json: string): ContentBlock[] {
  try {
    return JSON.parse(json) as ContentBlock[];
  } catch {
    return [];
  }
}

/** The typed text of a user message — its text blocks, joined. */
function userTextOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .filter(Boolean)
    .join('\n');
}

/**
 * Mirrors what `forkConversationAt` will accept, so the button only shows where
 * the fork can actually be made. An assistant row needs its own fork point; a
 * user row needs the previous turn's — or no previous turn at all, in which
 * case rewinding is just "start over with this text".
 */
function isRewindable(row: MessageRow, sdkBackend: boolean): boolean {
  if (!sdkBackend) return false;
  if (row.role === 'assistant') return row.sdk_uuid != null;
  if (row.role === 'user') return row.prev_has_uuid == null || row.prev_has_uuid === 1;
  return false;
}

function rowToChatMessage(row: MessageRow, rewindable: boolean): ChatMessage {
  let blocks = parseBlocks(row.blocks_json);
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
    const text = userTextOf(blocks);
    const images = blocks.filter(
      (b): b is ImageAttachmentBlock => b.type === 'image',
    );
    return {
      id: row.id,
      role: 'user',
      text,
      images: images.length > 0 ? images : undefined,
      createdAt: row.created_at,
      rewindable,
    };
  }
  if (row.role === 'system') {
    return { id: row.id, role: 'system', blocks, createdAt: row.created_at };
  }
  return { id: row.id, role: 'assistant', blocks, createdAt: row.created_at, rewindable };
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

  // The previous turn's fork point may sit outside this page, so it is looked
  // up per user row rather than inferred from the rows fetched — an index seek
  // backwards from the row's own seq, which normally stops one row up.
  const columns = `m.id, m.role, m.seq, m.created_at, m.blocks_json, m.sdk_uuid,
              CASE WHEN m.role = 'user' THEN (
                SELECT p.sdk_uuid IS NOT NULL FROM messages p
                 WHERE p.conversation_id = m.conversation_id
                   AND p.role = 'assistant' AND p.seq < m.seq
                 ORDER BY p.seq DESC LIMIT 1
              ) END AS prev_has_uuid`;
  const rows =
    beforeSeq != null
      ? db
          .prepare<[string, number, number], MessageRow>(
            `SELECT ${columns}
               FROM messages m
              WHERE m.conversation_id = ? AND m.seq < ?
              ORDER BY m.seq DESC LIMIT ?`,
          )
          .all(conversationId, beforeSeq, fetchLimit)
      : db
          .prepare<[string, number], MessageRow>(
            `SELECT ${columns}
               FROM messages m
              WHERE m.conversation_id = ?
              ORDER BY m.seq DESC LIMIT ?`,
          )
          .all(conversationId, fetchLimit);

  // OpenCode keeps its own session store, which has nothing to fork.
  const sdkBackend = getConversationBackend(conversationId) === 'sdk';
  const hasMoreOlder = rows.length > cap;
  const trimmed = (hasMoreOlder ? rows.slice(0, cap) : rows).reverse();
  const messages = trimmed.map((row) => rowToChatMessage(row, isRewindable(row, sdkBackend)));
  const oldestSeq = trimmed.length > 0 ? trimmed[0].seq : null;
  return { messages, oldestSeq, hasMoreOlder };
}

export function getMessagesForConversation(conversationId: string): ChatMessage[] {
  return getMessagesPage(conversationId, 200).messages;
}
