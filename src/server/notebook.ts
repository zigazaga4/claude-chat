/**
 * Per-conversation notebook: a private, free-text scratchpad the model
 * maintains for itself, scoped to a single conversation (keyed by the SDK
 * session id, which is also the conversation id). Its contents are injected
 * into the system prompt every turn, so the model can persist durable notes
 * that outlive the context window.
 *
 * Storage is a single TEXT blob per conversation. All editing is line-based
 * and done here as pure functions over that text, so the same logic drives
 * both the tool handler and any tests.
 */

import { getDb } from './db';

export type NotebookEditAction = 'append' | 'insert' | 'replace' | 'delete';

export function readNotebook(conversationId: string): string {
  const db = getDb();
  const row = db
    .prepare<[string], { content: string }>(
      `SELECT content FROM conversation_notes WHERE conversation_id = ?`,
    )
    .get(conversationId);
  return row?.content ?? '';
}

export function writeNotebook(conversationId: string, content: string, now: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO conversation_notes (conversation_id, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(conversation_id)
       DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(conversationId, content, now);
}

/** Split a notebook blob into lines. Empty content is zero lines (not one). */
function splitLines(content: string): string[] {
  return content === '' ? [] : content.split('\n');
}

export function lineCount(content: string): number {
  return splitLines(content).length;
}

/** Render the notebook with 1-based, right-aligned line numbers for the model. */
export function numbered(content: string): string {
  const lines = splitLines(content);
  if (lines.length === 0) return '(empty)';
  const width = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(width, ' ')}  ${l}`)
    .join('\n');
}

export type EditResult =
  | { ok: true; content: string; summary: string }
  | { ok: false; error: string };

/**
 * Apply a line-based edit to the notebook text. Pure — returns the new text
 * or a validation error, never touches storage. Line numbers are 1-based;
 * `insert` additionally accepts 0 to mean "before the first line".
 */
export function applyEdit(
  content: string,
  action: NotebookEditAction,
  args: { text?: string; start?: number; end?: number },
): EditResult {
  const lines = splitLines(content);
  const n = lines.length;
  const text = args.text ?? '';
  const textLines = text === '' ? [] : text.split('\n');

  if (action === 'append') {
    if (text === '') return { ok: false, error: 'text is required for append' };
    return {
      ok: true,
      content: [...lines, ...textLines].join('\n'),
      summary: `Appended ${textLines.length} line(s) at the end.`,
    };
  }

  if (action === 'insert') {
    if (args.start == null) {
      return { ok: false, error: 'start is required for insert (use 0 to insert at the top)' };
    }
    if (text === '') return { ok: false, error: 'text is required for insert' };
    const at = args.start;
    if (at < 0 || at > n) {
      return { ok: false, error: `start ${at} is out of range (valid 0..${n})` };
    }
    return {
      ok: true,
      content: [...lines.slice(0, at), ...textLines, ...lines.slice(at)].join('\n'),
      summary: `Inserted ${textLines.length} line(s) after line ${at}.`,
    };
  }

  // replace / delete both target an existing 1-based [start, end] range.
  if (args.start == null) {
    return { ok: false, error: `start is required for ${action}` };
  }
  if (n === 0) {
    return { ok: false, error: `notebook is empty — nothing to ${action}` };
  }
  const start = args.start;
  const end = args.end ?? start;
  if (start < 1 || start > n) {
    return { ok: false, error: `start ${start} is out of range (valid 1..${n})` };
  }
  if (end < start || end > n) {
    return { ok: false, error: `end ${end} is out of range (valid ${start}..${n})` };
  }

  if (action === 'delete') {
    return {
      ok: true,
      content: [...lines.slice(0, start - 1), ...lines.slice(end)].join('\n'),
      summary: `Deleted line(s) ${start}-${end}.`,
    };
  }

  // replace
  return {
    ok: true,
    content: [...lines.slice(0, start - 1), ...textLines, ...lines.slice(end)].join('\n'),
    summary: `Replaced line(s) ${start}-${end} with ${textLines.length} line(s).`,
  };
}
