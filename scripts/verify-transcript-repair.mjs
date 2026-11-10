// Checks src/server/transcriptRepair.ts: that it repairs what it should, and —
// the reason this script exists — that it does so without ever holding a whole
// transcript in memory unless a provider tool block genuinely has to be cut
// out. A 311 MB transcript used to take the server down on every resume.
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/verify-transcript-repair.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repairTranscript } from '../src/server/transcriptRepair.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-repair-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

// Count whole-file reads: the cheap paths must make none.
const realRead = fs.readFileSync;
let wholeFileReads = 0;
fs.readFileSync = (...args) => {
  wholeFileReads++;
  return realRead(...args);
};

let n = 0;
let fileNo = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`ok  ${name}`);
};

const USAGE = { input_tokens: 5, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } };
const assistant = (uuid, parent, id, content = [{ type: 'text', text: 'hi' }]) => ({
  type: 'assistant',
  uuid,
  parentUuid: parent,
  message: { ...(id === undefined ? {} : { id }), role: 'assistant', content, usage: USAGE },
});
const user = (uuid, parent, content) => ({
  type: 'user',
  uuid,
  parentUuid: parent,
  message: { role: 'user', content },
});
const toLines = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
function write(lines, { finalNewline = true } = {}) {
  const p = path.join(dir, `t${fileNo++}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + (finalNewline ? '\n' : ''));
  return p;
}
const bytes = (p) => realRead(p); // the script's own reads must not count as the repair's

/** Independent reference for the id fix: parse everything, strip ids back to the first msg_. */
function referenceIdFix(lines, cap = 64) {
  const out = [...lines];
  let fixes = 0;
  for (let i = out.length - 1; i >= 0 && fixes < cap; i--) {
    if (!out[i].trim()) continue;
    let rec;
    try {
      rec = JSON.parse(out[i]);
    } catch {
      continue;
    }
    if (rec?.type !== 'assistant' || typeof rec.message?.id !== 'string') continue;
    if (rec.message.id.startsWith('msg_')) break;
    const message = { ...rec.message };
    delete message.id;
    out[i] = JSON.stringify({ ...rec, message });
    fixes++;
  }
  return out;
}

const healthy = () => [
  user('u1', null, 'start'),
  assistant('a1', 'u1', 'msg_01'),
  user('u2', 'a1', 'more'),
  assistant('a2', 'u2', 'msg_02'),
];

// ── nothing to do ────────────────────────────────────────────────────────────
check('a healthy transcript is left alone and never read whole', () => {
  const p = write(toLines(healthy()));
  const before = bytes(p);
  wholeFileReads = 0;
  const r = repairTranscript(p);
  assert.equal(r.repaired, false);
  assert.deepEqual(bytes(p), before);
  assert.equal(wholeFileReads, 0);
  assert.equal(fs.existsSync(`${p}.bak`), false);
});

check('the usage counter is not mistaken for a provider tool block', () => {
  // Hundreds of records, each carrying "server_tool_use":{…} as a key.
  const recs = [user('u0', null, 'start')];
  for (let i = 1; i <= 300; i++) recs.push(assistant(`a${i}`, i === 1 ? 'u0' : `a${i - 1}`, `msg_${i}`));
  const p = write(toLines(recs));
  assert.ok(bytes(p).toString().split('"server_tool_use":{').length > 300);
  wholeFileReads = 0;
  assert.equal(repairTranscript(p).repaired, false);
  assert.equal(wholeFileReads, 0);
});

check('a missing file is a clean result, not a throw', () => {
  const r = repairTranscript(path.join(dir, 'nope.jsonl'));
  assert.deepEqual(r, { repaired: false, removed: 0, toolNames: [], idsDropped: 0 });
});

check('an empty file is a clean result', () => {
  const p = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(p, '');
  assert.equal(repairTranscript(p).repaired, false);
});

// ── the id fix, done in place ────────────────────────────────────────────────
check('a rate-limit style trailing id is dropped without reading the file whole', () => {
  const lines = toLines([...healthy(), assistant('a3', 'a2', 'e981bc13-c1bc-4f87-bcc5-d6d416e6b5cf'), { type: 'last-prompt', x: 1 }]);
  const p = write(lines);
  const original = bytes(p);
  wholeFileReads = 0;
  const r = repairTranscript(p);
  assert.equal(r.repaired, true);
  assert.equal(r.idsDropped, 1);
  assert.equal(r.removed, 0);
  assert.equal(wholeFileReads, 0);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
  assert.deepEqual(bytes(`${p}.bak`), original, '.bak is the pre-repair file');
  const last = bytes(p).toString().trim().split('\n');
  assert.equal(JSON.parse(last.at(-2)).message.id, undefined);
  assert.equal(JSON.parse(last.at(-2)).message.model, undefined);
});

check('only the end of the file changes; everything before it is byte-identical', () => {
  const recs = [user('u0', null, 'start')];
  for (let i = 1; i <= 50; i++) recs.push(assistant(`a${i}`, i === 1 ? 'u0' : `a${i - 1}`, `msg_${i}`));
  recs.push(assistant('bad', 'a50', 'gen-abc'));
  const lines = toLines(recs);
  const p = write(lines);
  const original = bytes(p);
  repairTranscript(p);
  const prefixLen = Buffer.byteLength(lines.slice(0, -1).join('\n') + '\n');
  assert.deepEqual(bytes(p).subarray(0, prefixLen), original.subarray(0, prefixLen));
  assert.ok(bytes(p).length < original.length);
});

check('every trailing unusable id is cleared, back to the first usable one', () => {
  const lines = toLines([
    ...healthy(),
    assistant('b1', 'a2', 'gen-1'),
    user('ub', 'b1', 'x'),
    assistant('b2', 'ub', 'gen-2'),
    assistant('b3', 'b2', 'plain-uuid'),
  ]);
  const p = write(lines);
  const r = repairTranscript(p);
  assert.equal(r.idsDropped, 3);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
  const survivors = bytes(p).toString().trim().split('\n').map(JSON.parse).filter((x) => x.type === 'assistant');
  assert.equal(survivors.find((x) => x.uuid === 'a2').message.id, 'msg_02', 'the usable id is untouched');
});

check('no more than 64 are cleared, newest first', () => {
  const recs = [user('u0', null, 'start')];
  for (let i = 1; i <= 70; i++) recs.push(assistant(`g${i}`, i === 1 ? 'u0' : `g${i - 1}`, `gen-${i}`));
  const lines = toLines(recs);
  const p = write(lines);
  const r = repairTranscript(p);
  assert.equal(r.idsDropped, 64);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
});

check('a record with no id is skipped over, not treated as the stop', () => {
  const lines = toLines([...healthy(), assistant('noid', 'a2', undefined), assistant('bad', 'noid', 'gen-1')]);
  const p = write(lines);
  repairTranscript(p);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
});

check('a transcript with no final newline is fixed without gaining or losing one', () => {
  const lines = toLines([...healthy(), assistant('bad', 'a2', 'gen-1')]);
  const p = write(lines, { finalNewline: false });
  repairTranscript(p);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n'));
});

check('multi-byte text elsewhere in the tail survives untouched', () => {
  const lines = toLines([
    user('u1', null, 'Bună, ce ar fi ș ț ă î â — 日本語 🚀'),
    assistant('a1', 'u1', 'msg_01', [{ type: 'text', text: 'Răspuns: ș ț 🚀' }]),
    assistant('bad', 'a1', 'gen-1'),
  ]);
  const p = write(lines);
  repairTranscript(p);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
});

check('the window widens past a multi-MB record to find the usable id', () => {
  const huge = 'x'.repeat(3_000_000);
  const lines = toLines([
    user('u0', null, 'start'),
    assistant('a1', 'u0', 'msg_01'),
    user('big', 'a1', [{ type: 'tool_result', tool_use_id: 't', content: huge }]),
    assistant('bad', 'big', 'gen-1'),
  ]);
  const p = write(lines);
  assert.ok(bytes(p).length > 2_000_000, 'larger than the first window');
  wholeFileReads = 0;
  const r = repairTranscript(p);
  assert.equal(r.idsDropped, 1);
  assert.equal(wholeFileReads, 0);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
});

check('records on both sides of a multi-MB record are handled', () => {
  const huge = 'y'.repeat(2_500_000);
  const lines = toLines([
    user('u0', null, 'start'),
    assistant('a0', 'u0', 'msg_00'),
    assistant('bad1', 'a0', 'gen-1'),
    user('big', 'bad1', [{ type: 'tool_result', tool_use_id: 't', content: huge }]),
    assistant('bad2', 'big', 'gen-2'),
  ]);
  const p = write(lines);
  const r = repairTranscript(p);
  assert.equal(r.idsDropped, 2);
  assert.equal(bytes(p).toString(), referenceIdFix(lines).join('\n') + '\n');
});

check('a second run finds nothing left to do', () => {
  const p = write(toLines([...healthy(), assistant('bad', 'a2', 'gen-1')]));
  assert.equal(repairTranscript(p).repaired, true);
  assert.equal(repairTranscript(p).repaired, false);
});

// ── provider tool blocks, the full path ──────────────────────────────────────
const providerBlock = (key) =>
  key === 'type-first'
    ? { type: 'server_tool_use', id: 'call_abc', name: 'analyze_image', input: {} }
    : { id: 'call_abc', name: 'analyze_image', input: {}, type: 'server_tool_use' };

for (const key of ['type-first', 'type-last']) {
  check(`a real server_tool_use block (${key}) is cut out and its result with it`, () => {
    const lines = toLines([
      user('u1', null, 'look'),
      assistant('a1', 'u1', 'msg_01', [providerBlock(key)]),
      user('r1', 'a1', [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'img' }]),
      assistant('a2', 'r1', 'msg_02'),
    ]);
    const p = write(lines);
    wholeFileReads = 0;
    const r = repairTranscript(p);
    assert.equal(r.repaired, true);
    assert.equal(r.removed, 2);
    assert.deepEqual(r.toolNames, ['analyze_image']);
    assert.ok(wholeFileReads >= 1, 'the full path was taken');
    const out = bytes(p).toString().trim().split('\n').map(JSON.parse);
    assert.deepEqual(out.map((x) => x.uuid), ['u1', 'a2']);
    assert.equal(out[1].parentUuid, 'u1', 'the child is relinked onto the surviving ancestor');
  });
}

check('a provider block and an unusable trailing id are both repaired together', () => {
  const lines = toLines([
    user('u1', null, 'look'),
    assistant('a1', 'u1', 'msg_01', [providerBlock('type-first')]),
    assistant('a2', 'a1', 'msg_02'),
    assistant('bad', 'a2', 'gen-1'),
  ]);
  const p = write(lines);
  const r = repairTranscript(p);
  assert.equal(r.removed, 1);
  assert.equal(r.idsDropped, 1);
  const out = bytes(p).toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(out.map((x) => x.uuid), ['u1', 'a2', 'bad']);
  assert.equal(out[2].message.id, undefined);
  assert.equal(out[1].parentUuid, 'u1');
});

// ── the chunked scan, at its seams ───────────────────────────────────────────
const CHUNK = 8 * 1024 * 1024;

/** A file whose line `needleLine` has its marker starting `straddle` bytes before the chunk edge. */
function fileWithMarkerAtSeam(needleLine, markerText, straddle) {
  const markerAt = needleLine.indexOf(markerText);
  assert.ok(markerAt >= 0);
  const head = JSON.stringify(user('h', null, 'start')) + '\n';
  const wrapperOverhead = JSON.stringify({ type: 'user', uuid: 'pad', pad: '' }).length + 1;
  const padLen = CHUNK - straddle - markerAt - Buffer.byteLength(head) - wrapperOverhead;
  assert.ok(padLen > 0);
  const filler = JSON.stringify({ type: 'user', uuid: 'pad', pad: 'z'.repeat(padLen) }) + '\n';
  const file = head + filler + needleLine + '\n' + JSON.stringify(assistant('t', 'h', 'msg_t')) + '\n';
  const at = Buffer.from(file).indexOf(markerText);
  assert.equal(at, CHUNK - straddle, 'marker lands where intended');
  const p = path.join(dir, `seam${fileNo++}.jsonl`);
  fs.writeFileSync(p, file);
  return p;
}

for (const straddle of [3, 1, 17, 18]) {
  check(`a real block whose marker crosses the 8 MiB seam (${straddle} bytes before it) is found`, () => {
    const line = JSON.stringify(assistant('blk', 'h', 'msg_b', [providerBlock('type-first')]));
    const p = fileWithMarkerAtSeam(line, '"server_tool_use"', straddle);
    wholeFileReads = 0;
    const r = repairTranscript(p);
    assert.equal(r.removed, 1, 'block removed');
    assert.ok(wholeFileReads >= 1);
  });

  check(`a usage counter whose marker crosses the 8 MiB seam (${straddle} bytes before it) is ignored`, () => {
    const line = JSON.stringify(assistant('cnt', 'h', 'msg_c'));
    const p = fileWithMarkerAtSeam(line, '"server_tool_use"', straddle);
    wholeFileReads = 0;
    assert.equal(repairTranscript(p).repaired, false);
    assert.equal(wholeFileReads, 0);
  });
}

console.log(`\nALL ${n} CHECKS PASSED`);
