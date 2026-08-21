/**
 * Primitives shared by every filesystem-facing MCP tool in this app.
 *
 * There are two of those servers — `remote` (sshTools.ts, backed by SFTP) and
 * `local` (localTools.ts, backed by node:fs) — and the whole point is that the
 * model cannot tell them apart from the shape of what comes back. A read is a
 * read: same `cat -n` numbering, same 2000-line default, same empty-file
 * reminder, same promise that an image arrives as something it can actually
 * look at. Only the sentence naming the machine differs.
 *
 * Keeping that contract in one file is what makes it true. When these helpers
 * lived inside sshTools.ts the only way to add a second server was to copy
 * them, and two copies of "what does a read look like" drift the moment either
 * side is touched.
 */

import { Buffer } from 'node:buffer';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function image(
  data: string,
  mimeType: string,
  note?: string,
): ToolResult {
  const content: ContentBlock[] = [{ type: 'image', data, mimeType }];
  if (note) content.unshift({ type: 'text', text: note });
  return { content };
}

/** Default number of lines the built-in Read tool returns when no limit is given. */
export const READ_DEFAULT_LIMIT = 2000;

/**
 * Mirror of the built-in Read tool's `<system-reminder>` placeholder for empty
 * files. The CLI uses this exact wording; matching it keeps the model's
 * reaction identical regardless of which machine the file lives on.
 */
export const EMPTY_FILE_REMINDER =
  '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * `cat -n` style line numbering: 6-char right-aligned line number + tab +
 * content. This is the exact format the built-in Read tool returns, which the
 * Edit tool's description warns the model about ("preserve the exact
 * indentation … AFTER the line number prefix"). Matching it keeps prompts
 * written for the built-ins valid for these tools too.
 */
export function formatCatN(lines: string[], firstLineNumber: number): string {
  return lines
    .map((line, i) => `${String(firstLineNumber + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

/** A NUL byte in the first 8 KB is the same heuristic `grep -I` uses. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Turn a fully-read file into the text half of a Read result: empty-file
 * reminder, binary refusal, offset/limit slicing, `cat -n` numbering, and the
 * "pass offset=N to continue" hint. Identical for local and remote files, so
 * both servers hand the buffer here rather than re-deriving the rules.
 *
 * `binaryHint` is the one machine-specific part — it names which tool refused
 * and what it can render instead.
 */
export function renderTextRead(opts: {
  buf: Buffer;
  /** Absolute path, used in the messages. */
  label: string;
  offset?: number;
  limit?: number;
  binaryHint: string;
}): ToolResult {
  const { buf, label, offset, limit, binaryHint } = opts;
  if (buf.length === 0) return ok(EMPTY_FILE_REMINDER);
  if (looksBinary(buf)) {
    return err(
      `${label} appears to be a binary file (${buf.length} bytes). ${binaryHint}`,
    );
  }
  const allLines = buf.toString('utf8').split('\n');
  // Mirror cat -n: a file ending in "\n" produces a trailing empty "line" via
  // split; drop it so line counts match `wc -l` + 1.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  const totalLines = allLines.length;
  const startIdx = Math.max(0, (offset ?? 1) - 1);
  const endIdx = Math.min(totalLines, startIdx + (limit ?? READ_DEFAULT_LIMIT));
  if (startIdx >= totalLines && totalLines > 0) {
    return ok(
      `(offset ${offset} is past the end of the file — total ${totalLines} lines)`,
    );
  }
  const formatted = formatCatN(allLines.slice(startIdx, endIdx), startIdx + 1);
  if (endIdx >= totalLines) return ok(formatted);
  const remaining = totalLines - endIdx;
  return ok(
    `${formatted}\n\n(... ${remaining} more line${
      remaining === 1 ? '' : 's'
    }. Pass offset=${endIdx + 1} to continue reading.)`,
  );
}
