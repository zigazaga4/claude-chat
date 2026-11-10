/**
 * Repair for CLI session transcripts poisoned by provider-executed tools.
 *
 * Some Anthropic-compatible providers attach their own server-side tools on
 * top of the ones this app registers (Z.AI injects a vision MCP, exposing an
 * `analyze_image` that never appears in the CLI's tool list and so cannot be
 * filtered with `disallowedTools`). When the model calls one, the provider
 * writes a `server_tool_use` block into the session transcript.
 *
 * That is where it turns fatal. Z.AI mints those ids in OpenAI form
 * (`call_<hex>`) while its own request validator requires `^srvtoolu_`, so on
 * every later turn the CLI faithfully replays an id the provider itself
 * refuses:
 *
 *   messages.38.content.3.server_tool_use.id:
 *     String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'
 *
 * The conversation is then permanently unresumable — the bad blocks are baked
 * into its history and every resume 400s before the model is even reached.
 *
 * Removing a record is not enough: transcript records form a linked list via
 * `parentUuid`, so dropping one orphans its children. Each removed record's
 * children are relinked onto its surviving ancestor, and any `tool_result`
 * answering a removed call is dropped with it so no dangling reference is
 * left behind.
 *
 * A second, unrelated defect is repaired here for the same reason — it is
 * baked into history and fails the turn before the model is reached.
 *
 * A conversation can be served by several providers over its life, and the CLI
 * records whatever message id each one returned: `msg_…` from Anthropic, but
 * `gen-…` from OpenRouter and bare UUIDs elsewhere. Current CLI builds attach
 * the newest assistant id to requests as a cache-diagnostics
 * `diagnostics.previous_message_id`, and Anthropic validates its shape:
 *
 *   diagnostics.previous_message_id: must be the id from a prior
 *     /v1/messages response (starts with msg_)
 *
 * So a conversation whose last answer came from a non-Anthropic model cannot
 * be resumed on a Claude model at all. The id carries no meaning for Anthropic
 * anyway, so it is dropped from the record; absent, the CLI falls back to the
 * `null` it already sends on a first turn, which the API accepts.
 *
 * Neither defect is allowed to cost a copy of the transcript in memory. This
 * runs on every resumed turn, synchronously, inside the server process, and a
 * transcript is not small: one reached 311 MB, where parsing it is a ~1.4 GB
 * allocation against a ~1.7 GB heap. That did not fail once — it failed on
 * every resume, in a loop, because pm2 restarted the server straight back into
 * the same conversation. So the checks that decide whether anything is wrong
 * read a chunk or the tail, never the file, and the id fix (by far the more
 * common repair — any rate-limit or auth error leaves an unusable id on the
 * newest record) rewrites only the end of the file.
 */

import fs from 'node:fs';

type AnyRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is AnyRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Content blocks of a transcript record, when it has any. */
function contentBlocks(rec: AnyRecord): AnyRecord[] {
  const message = isRecord(rec.message) ? rec.message : rec;
  const content = message.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** An id the Messages API will accept as a `previous_message_id`. */
const ANTHROPIC_MSG_ID = /^msg_/;

/**
 * How far back the id fix walks. A conversation served entirely by a
 * non-Anthropic provider has no usable id to stop at, and rewriting thousands
 * of records to satisfy a diagnostics field such a turn never sends is not
 * worth the write.
 */
const MAX_TRAILING_ID_FIXES = 64;

/** Tail of the file scanned to find the newest assistant record. */
const TAIL_SCAN_BYTES = 2_000_000;

/** Chunk read while scanning a whole transcript for a byte sequence. */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

/** Widest tail the in-place id fix reads before settling for what it has. */
const MAX_ID_FIX_WINDOW_BYTES = 64 * 1024 * 1024;

/** Read until `length` bytes are in or the file ends; returns how many. */
function readFully(
  fd: number,
  into: Buffer,
  offset: number,
  length: number,
  position: number,
): number {
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, into, offset + done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done;
}

/** The end of a transcript, read without touching the rest of it. */
type Tail = {
  text: string;
  /** True when `text` starts mid-file, so its first line may be a fragment. */
  truncated: boolean;
};

function readTail(fd: number, size: number): Tail {
  const length = Math.min(size, TAIL_SCAN_BYTES);
  const buf = Buffer.allocUnsafe(length);
  const got = readFully(fd, buf, 0, length, size - length);
  return { text: buf.toString('utf8', 0, got), truncated: size > length };
}

const PROVIDER_TOOL_MARKER = Buffer.from('"server_tool_use"');

/**
 * Whether any record holds a `server_tool_use` BLOCK, streamed in chunks so a
 * transcript of any size costs one chunk of memory instead of a copy of itself.
 *
 * The bare string is not evidence of a block. Every assistant record's `usage`
 * carries a `"server_tool_use":{"web_search_requests":0,…}` counter, so it
 * appears thousands of times in an ordinary transcript (6,309 in the 311 MB
 * one) — and treating each as a hit sent virtually every resumed turn down the
 * full-parse path. As a block's `type` the string is a VALUE, followed by `,`
 * or `}`; as that counter it is a KEY, followed by `:`. Only the first counts.
 */
function fileHasProviderToolBlock(fd: number, size: number): boolean {
  const marker = PROVIDER_TOOL_MARKER;
  // Carried into the next chunk so a hit cut by a chunk edge still gets to see
  // the byte that follows it.
  const carry = marker.length;
  const buf = Buffer.allocUnsafe(SCAN_CHUNK_BYTES + carry);
  let kept = 0;
  let position = 0;
  while (position < size) {
    const want = Math.min(SCAN_CHUNK_BYTES, size - position);
    const got = readFully(fd, buf, kept, want, position);
    if (got <= 0) break;
    position += got;
    const end = kept + got;
    const view = buf.subarray(0, end);
    for (let at = view.indexOf(marker); at >= 0; at = view.indexOf(marker, at + 1)) {
      const next = at + marker.length;
      if (next >= end) {
        // Nothing after it to judge by. At the end of the file that is a hit
        // (a false positive only costs the slow path); otherwise it lies in
        // the carried bytes and is judged again with the next chunk.
        if (position >= size) return true;
        break;
      }
      if (view[next] !== 0x3a /* ':' */) return true;
    }
    kept = Math.min(carry, end);
    buf.copy(buf, 0, end - kept, end);
  }
  return false;
}

/**
 * Whether the newest assistant record carries an id the Messages API rejects
 * as a `previous_message_id`.
 *
 * Deliberately reads only the tail. This is a precondition checked on every
 * resumed turn, and the answer only ever depends on the last assistant record,
 * so it must not cost a parse of the whole transcript. A single record can
 * reach several MB, so the first line of the slice may be truncated
 * mid-record; it is discarded rather than parsed.
 */
function hasUnusableTrailingId({ text, truncated }: Tail): boolean {
  const lines = text.split('\n');
  if (truncated) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== 'assistant') continue;
    const message = isRecord(value.message) ? value.message : null;
    if (!message || typeof message.id !== 'string') continue;
    return !ANTHROPIC_MSG_ID.test(message.id);
  }
  return false;
}

/**
 * Drop the unusable trailing assistant ids by rewriting only the END of the
 * file; returns how many records were changed (0 = nothing was touched).
 *
 * This fix never moves, removes or reorders a record — it deletes one key from
 * each of the newest few — so it has no need of the transcript as a whole. It
 * reads a window from the end, walks it backwards exactly as the full repair's
 * pass 0 does, and overwrites from the first changed line onward. Lines it does
 * not change are carried over as the bytes they were, never decoded.
 *
 * The window starts small and widens when the walk runs off its top before
 * finding the usable id to stop at (a multi-MB tool result can sit between).
 * At the widest it settles for what it has: the newest records are the ones the
 * CLI sends, and a partial fix beats a server that dies trying for a full one.
 */
function dropTrailingIds(path: string, size: number): number {
  const fd = fs.openSync(path, 'r');
  try {
    for (let window = TAIL_SCAN_BYTES; ; window = Math.min(window * 4, MAX_ID_FIX_WINDOW_BYTES)) {
      const length = Math.min(size, window);
      const start = size - length;
      const buf = Buffer.allocUnsafe(length);
      const got = readFully(fd, buf, 0, length, start);

      // A window cut mid-file begins inside a line; that fragment is skipped.
      let from = 0;
      if (start > 0) {
        const newline = buf.indexOf(0x0a);
        from = newline < 0 || newline >= got ? got : newline + 1;
      }
      const lines: Array<[number, number]> = [];
      for (let s = from; s < got; ) {
        const nl = buf.indexOf(0x0a, s);
        const e = nl < 0 || nl > got ? got : nl;
        lines.push([s, e]);
        s = e + 1;
      }

      const fixes: Array<{ at: number; line: Buffer }> = [];
      let settled = start === 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const [s, e] = lines[i];
        if (e === s) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(buf.toString('utf8', s, e));
        } catch {
          continue;
        }
        if (!isRecord(rec) || rec.type !== 'assistant') continue;
        const message = isRecord(rec.message) ? rec.message : null;
        if (!message || typeof message.id !== 'string') continue;
        if (ANTHROPIC_MSG_ID.test(message.id)) {
          settled = true;
          break;
        }
        const stripped: AnyRecord = { ...message };
        delete stripped.id;
        fixes.push({ at: i, line: Buffer.from(JSON.stringify({ ...rec, message: stripped })) });
        if (fixes.length >= MAX_TRAILING_ID_FIXES) {
          settled = true;
          break;
        }
      }
      if (!settled && window < MAX_ID_FIX_WINDOW_BYTES) continue;
      if (fixes.length === 0) return 0;

      // Splice the changed lines into the window, oldest first.
      const parts: Buffer[] = [];
      let cursor = from;
      for (const fix of fixes.reverse()) {
        const [s, e] = lines[fix.at];
        parts.push(buf.subarray(cursor, s), fix.line);
        cursor = e;
      }
      parts.push(buf.subarray(cursor, got));
      const rewritten = Buffer.concat(parts);

      fs.copyFileSync(path, `${path}.bak`);
      const out = fs.openSync(path, 'r+');
      try {
        let written = 0;
        while (written < rewritten.length) {
          written += fs.writeSync(
            out,
            rewritten,
            written,
            rewritten.length - written,
            start + from + written,
          );
        }
        fs.ftruncateSync(out, start + from + rewritten.length);
      } finally {
        fs.closeSync(out);
      }
      return fixes.length;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export type RepairResult = {
  /** True when the transcript was modified (and therefore rewritten). */
  repaired: boolean;
  /** Number of transcript records removed. */
  removed: number;
  /** Names of the provider tools whose calls were removed. */
  toolNames: string[];
  /** Assistant records whose unusable `message.id` was dropped. */
  idsDropped: number;
};

/**
 * Strip provider-executed tool calls (and their results) from a CLI session
 * transcript, preserving the `parentUuid` chain.
 *
 * Safe to call on a healthy transcript: with nothing to remove it performs no
 * write and reports `repaired: false`. Malformed lines are passed through
 * untouched rather than dropped — this repairs one specific defect and must
 * not become a lossy rewrite of everything else.
 */
export function repairTranscript(path: string): RepairResult {
  const clean: RepairResult = {
    repaired: false,
    removed: 0,
    toolNames: [],
    idsDropped: 0,
  };
  // Bail out before parsing anything. Each defect has a cheap precondition:
  // pass 1 only ever marks a record holding a `server_tool_use` block, and the
  // id fix only ever depends on the newest assistant record. When neither
  // applies there is provably nothing to do, and virtually every transcript is
  // in exactly that state.
  //
  // Without this the common case was: read the whole transcript, split it,
  // JSON.parse every single line into an object graph, discover `doomed` is
  // empty, and throw all of it away. That is the most expensive thing this
  // process does on a resumed turn, it happens on every resumed turn, and it
  // is synchronous so it blocks the event loop while it runs. Transcripts here
  // reach 311 MB, where the parsed form is a ~1.4 GB allocation.
  //
  // Both preconditions are answered from the file descriptor — a streamed scan
  // and the tail — so even the "nothing to do" answer never holds the file.
  // The tool scan is exact rather than a heuristic: JSON.stringify never
  // escapes plain ASCII, so a block of that type always serializes with the
  // marker verbatim. A false positive merely falls through to the full path.
  let size = 0;
  let hasProviderTool = false;
  let needsIdFix = false;
  try {
    const fd = fs.openSync(path, 'r');
    try {
      size = fs.fstatSync(fd).size;
      hasProviderTool = fileHasProviderToolBlock(fd, size);
      needsIdFix = hasUnusableTrailingId(readTail(fd, size));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return clean;
  }
  if (!hasProviderTool && !needsIdFix) return clean;

  // Only the ids are wrong: nothing needs removing or relinking, so only the
  // end of the file needs rewriting.
  if (!hasProviderTool) {
    const idsDropped = dropTrailingIds(path, size);
    return idsDropped > 0 ? { ...clean, repaired: true, idsDropped } : clean;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return clean;
  }
  const lines = raw.split('\n');
  const parsed = lines.map((line) => {
    if (!line.trim()) return null;
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  });

  // Pass 0 — drop trailing assistant ids the API will not take as a
  // `previous_message_id`. Walks back from the newest record and stops at the
  // first usable `msg_` id, because that is the one the CLI reaches next once
  // the ids above it are gone.
  const idFixed = new Map<number, AnyRecord>();
  if (needsIdFix) {
    let fixes = 0;
    for (let i = parsed.length - 1; i >= 0 && fixes < MAX_TRAILING_ID_FIXES; i--) {
      const rec = parsed[i];
      if (!rec || rec.type !== 'assistant') continue;
      const message = isRecord(rec.message) ? rec.message : null;
      if (!message || typeof message.id !== 'string') continue;
      if (ANTHROPIC_MSG_ID.test(message.id)) break;
      const stripped: AnyRecord = { ...message };
      delete stripped.id;
      idFixed.set(i, { ...rec, message: stripped });
      fixes++;
    }
  }

  // Pass 1 — find the provider tool calls and the ids they were issued under.
  const doomed = new Set<number>();
  const doomedIds = new Set<string>();
  const toolNames = new Set<string>();
  if (hasProviderTool) {
    parsed.forEach((rec, i) => {
      if (!rec) return;
      for (const block of contentBlocks(rec)) {
        if (block.type !== 'server_tool_use') continue;
        doomed.add(i);
        if (typeof block.id === 'string') doomedIds.add(block.id);
        if (typeof block.name === 'string') toolNames.add(block.name);
      }
    });

    // Pass 2 — take the results answering those calls down with them.
    parsed.forEach((rec, i) => {
      if (!rec || doomed.has(i)) return;
      for (const block of contentBlocks(rec)) {
        const refId = block.tool_use_id;
        if (typeof refId === 'string' && doomedIds.has(refId)) {
          doomed.add(i);
          break;
        }
      }
    });
  }
  if (doomed.size === 0 && idFixed.size === 0) return clean;

  // Pass 3 — rebuild, relinking each removed record's children onto its
  // surviving ancestor so the parentUuid chain stays continuous.
  const reparent = new Map<string, unknown>();
  const out: string[] = [];
  parsed.forEach((rec, i) => {
    if (!rec) {
      if (lines[i].trim()) out.push(lines[i]);
      return;
    }
    let parent = rec.parentUuid;
    while (typeof parent === 'string' && reparent.has(parent)) {
      parent = reparent.get(parent);
    }
    if (doomed.has(i)) {
      if (typeof rec.uuid === 'string') reparent.set(rec.uuid, parent);
      return;
    }
    const base = idFixed.get(i) ?? rec;
    if (parent !== rec.parentUuid) {
      out.push(JSON.stringify({ ...base, parentUuid: parent }));
      return;
    }
    if (idFixed.has(i)) {
      out.push(JSON.stringify(base));
      return;
    }
    out.push(lines[i]);
  });

  fs.copyFileSync(path, `${path}.bak`);
  fs.writeFileSync(path, `${out.join('\n')}\n`);
  return {
    repaired: true,
    removed: doomed.size,
    toolNames: [...toolNames].sort(),
    idsDropped: idFixed.size,
  };
}
