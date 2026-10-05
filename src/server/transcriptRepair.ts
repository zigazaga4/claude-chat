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
function hasUnusableTrailingId(raw: string): boolean {
  const from = Math.max(0, raw.length - TAIL_SCAN_BYTES);
  const lines = raw.slice(from).split('\n');
  if (from > 0) lines.shift();
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
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return clean;
  }

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
  // reach 231 MB, where the parsed form is a multi-hundred-MB allocation.
  //
  // The tool scan is exact rather than a heuristic: JSON.stringify never
  // escapes plain ASCII, so a block of that type always serializes with this
  // substring verbatim. A false positive merely falls through to the full path.
  const hasProviderTool = raw.includes('"server_tool_use"');
  const needsIdFix = hasUnusableTrailingId(raw);
  if (!hasProviderTool && !needsIdFix) return clean;

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
