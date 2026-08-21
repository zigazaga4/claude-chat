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

export type RepairResult = {
  /** True when the transcript was modified (and therefore rewritten). */
  repaired: boolean;
  /** Number of transcript records removed. */
  removed: number;
  /** Names of the provider tools whose calls were removed. */
  toolNames: string[];
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
  const clean: RepairResult = { repaired: false, removed: 0, toolNames: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return clean;
  }

  // Bail out before parsing anything. Pass 1 below only ever marks a record
  // because it holds a `server_tool_use` block, so if that string occurs
  // nowhere in the file there is provably nothing to remove — and virtually
  // every transcript is in exactly that state.
  //
  // Without this the common case was: read the whole transcript, split it,
  // JSON.parse every single line into an object graph, discover `doomed` is
  // empty, and throw all of it away. That is the most expensive thing this
  // process does on a resumed turn, it happens on every resumed turn, and it
  // is synchronous so it blocks the event loop while it runs. Transcripts here
  // reach 231 MB, where the parsed form is a multi-hundred-MB allocation.
  //
  // The scan is exact rather than a heuristic: JSON.stringify never escapes
  // plain ASCII, so a block of that type always serializes with this substring
  // verbatim. A false positive merely falls through to the original path.
  if (!raw.includes('"server_tool_use"')) return clean;

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

  // Pass 1 — find the provider tool calls and the ids they were issued under.
  const doomed = new Set<number>();
  const doomedIds = new Set<string>();
  const toolNames = new Set<string>();
  parsed.forEach((rec, i) => {
    if (!rec) return;
    for (const block of contentBlocks(rec)) {
      if (block.type !== 'server_tool_use') continue;
      doomed.add(i);
      if (typeof block.id === 'string') doomedIds.add(block.id);
      if (typeof block.name === 'string') toolNames.add(block.name);
    }
  });
  if (doomed.size === 0) return clean;

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
    if (parent !== rec.parentUuid) {
      out.push(JSON.stringify({ ...rec, parentUuid: parent }));
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
  };
}
