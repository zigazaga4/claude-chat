/**
 * End-to-end check of forkConversationAt ("Rewind to here") against a
 * throwaway database and a throwaway HOME, seeded with a copy of a REAL CLI
 * transcript. The real ~/.claude-chat / ~/.cloudchat database and the real
 * ~/.claude/projects transcripts are only ever read (to pick the source copy).
 *
 * Run:  node --experimental-transform-types --import ./scripts/register-ts.mjs \
 *         scripts/verify-rewind.mjs [path/to/source-transcript.jsonl]
 *
 * Without an argument (or REWIND_TRANSCRIPT) it picks the smallest real
 * transcript under ~/.claude/projects with at least two typed user turns.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- pick the source transcript BEFORE HOME is redirected -----------------
const realHome = os.homedir();

function typedPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  const t =
    typeof c === 'string'
      ? c
      : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result')
        ? c.find((b) => b?.type === 'text')?.text
        : null;
  return typeof t === 'string' && t.trim() && !t.startsWith('<') ? t : null;
}

function pickTranscript() {
  const explicit = process.argv[2] || process.env.REWIND_TRANSCRIPT;
  if (explicit) return explicit;
  const root = path.join(realHome, '.claude', 'projects');
  const candidates = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, dir.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const p = path.join(root, dir.name, f.name);
      const size = fs.statSync(p).size;
      if (size < 2 * 1024 * 1024) candidates.push({ p, size });
    }
  }
  candidates.sort((a, b) => a.size - b.size);
  for (const { p } of candidates) {
    let prompts = 0;
    let answers = 0;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (typedPrompt(o)) prompts++;
        if (o.type === 'assistant' && !o.isSidechain) answers++;
      } catch {
        /* skip */
      }
    }
    if (prompts >= 2 && answers >= 2) return p;
  }
  throw new Error('no real transcript with two or more typed turns found under ~/.claude/projects');
}

const SOURCE = pickTranscript();
const SOURCE_ID = path.basename(SOURCE, '.jsonl');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const realSourceHash = sha(fs.readFileSync(SOURCE));

// ---- sandbox ---------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rewind-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(home, { recursive: true });
// os.homedir() reads $HOME on POSIX: that is what puts both the CLI's
// ~/.claude/projects and this app's data dir inside the sandbox.
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CHAT_DB_PATH = path.join(sandbox, 'test.db');
if (!os.homedir().startsWith(sandbox)) throw new Error('HOME redirection failed');

const { getDb } = await import('../src/server/db.ts');
const conv = await import('../src/server/conversations.ts');
const { forkConversationAt, ensureConversation, upsertMessage, getMessagesPage, sdkTranscriptPath } =
  conv;
const { touchWorkspace, getWorkspace } = await import('../src/server/workspaces.ts');
const { writeNotebook, readNotebook } = await import('../src/server/notebook.ts');
const sdk = await import('@anthropic-ai/claude-agent-sdk');

const db = getDb();
if (!db.name.startsWith(sandbox)) throw new Error(`refusing to run against ${db.name}`);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`source transcript: ${SOURCE} (${fs.statSync(SOURCE).size} bytes)`);
console.log(`sandbox: ${sandbox}`);

// ---- seed: transcript copy + matching rows ---------------------------------
const WS = path.join(home, 'projects', 'alpha');
fs.mkdirSync(WS, { recursive: true });
touchWorkspace(WS, Date.now());
const srcPath = sdkTranscriptPath(WS, SOURCE_ID);
fs.mkdirSync(path.dirname(srcPath), { recursive: true });
fs.copyFileSync(SOURCE, srcPath);
const folder = path.dirname(srcPath);

const chain = await sdk.getSessionMessages(SOURCE_ID, { dir: WS });
const promptIdx = chain.flatMap((m, i) => (typedPrompt(m) ? [i] : []));
if (promptIdx.length < 2) throw new Error('source transcript has fewer than two typed turns');
if (promptIdx[0] !== 0) promptIdx.unshift(0);

/**
 * One cloudchat turn per typed prompt: user row at seq 10k, assistant row at
 * 10k+1 whose sdk_uuid is the turn's last chain entry — exactly what the chat
 * route records — or null when the turn produced no assistant entry. A system
 * row (a compaction divider) sits right after the first answer.
 */
const turns = promptIdx.map((p, k) => {
  const end = (promptIdx[k + 1] ?? chain.length) - 1;
  const answered = chain.slice(p + 1, end + 1).some((m) => m.type === 'assistant');
  return {
    k,
    prompt: typedPrompt(chain[p]),
    lastUuid: answered ? chain[end].uuid : null,
    lastIdx: answered ? end : null,
  };
});
const T0 = Date.now() - 60_000;
ensureConversation(SOURCE_ID, WS, T0, { backend: 'sdk' });
db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('Seeded original', SOURCE_ID);
for (const t of turns) {
  upsertMessage({
    id: `user_src_${t.k}`,
    conversationId: SOURCE_ID,
    role: 'user',
    seq: 10 * t.k,
    createdAt: T0 + t.k,
    blocks: [{ type: 'text', id: `b_u${t.k}`, text: t.prompt }],
  });
  upsertMessage({
    id: `asst_src_${t.k}`,
    conversationId: SOURCE_ID,
    role: 'assistant',
    seq: 10 * t.k + 1,
    createdAt: T0 + t.k,
    blocks: [{ type: 'text', id: `b_a${t.k}`, text: `answer ${t.k}` }],
    sdkUuid: t.lastUuid,
  });
}
upsertMessage({
  id: 'sys_src_0',
  conversationId: SOURCE_ID,
  role: 'system',
  seq: 2,
  createdAt: T0,
  blocks: [{ type: 'compact_boundary', id: 'b_s0', trigger: 'auto' }],
});
writeNotebook(SOURCE_ID, 'notebook line 1\nnotebook line 2', T0);

const answered = turns.filter((t) => t.lastUuid);
const unanswered = turns.find((t, i) => i > 0 && !t.lastUuid);
console.log(
  `seeded ${turns.length} turns from a ${chain.length}-entry chain ` +
    `(${answered.length} with a fork point${unanswered ? `, turn ${unanswered.k} without` : ''})`,
);

// ---- helpers ---------------------------------------------------------------
const srcRows = () =>
  JSON.stringify(
    db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(SOURCE_ID),
  );
const srcConvRow = () =>
  JSON.stringify(db.prepare('SELECT * FROM conversations WHERE id = ?').get(SOURCE_ID));
const transcriptFiles = () => fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).sort();
const rowsOf = (id) =>
  db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(id);
const forkedFromOf = (id) => {
  const map = new Map();
  for (const line of fs.readFileSync(sdkTranscriptPath(WS, id), 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (o.forkedFrom && o.uuid) map.set(o.uuid, o.forkedFrom.messageUuid);
  }
  return map;
};

const before = {
  transcript: sha(fs.readFileSync(srcPath)),
  rows: srcRows(),
  conv: srcConvRow(),
  notes: readNotebook(SOURCE_ID),
};

/** Shared assertions for a successful fork that cut the transcript at `cutTurn`. */
async function checkFork(label, res, { cutTurn, endSeq, prefill }) {
  check(`${label}: reports ok with a new conversation`, res.ok && typeof res.conversationId === 'string', JSON.stringify(res));
  if (!res.ok || !res.conversationId) return null;
  const id = res.conversationId;
  check(`${label}: new id differs from the original`, id !== SOURCE_ID);
  check(`${label}: cwd / backend echoed`, res.cwd === WS && res.backend === 'sdk');
  check(`${label}: prefill`, res.prefill === prefill, JSON.stringify(res.prefill));

  const p = sdkTranscriptPath(WS, id);
  check(`${label}: new transcript exists`, fs.existsSync(p));
  const forkChain = await sdk.getSessionMessages(id, { dir: WS });
  const ff = forkedFromOf(id);
  const last = forkChain.at(-1);
  check(
    `${label}: fork chain ends at the remapped cut entry`,
    last && ff.get(last.uuid) === cutTurn.lastUuid && last.uuid !== cutTurn.lastUuid,
    `last=${last?.uuid} from=${last && ff.get(last.uuid)} want=${cutTurn.lastUuid}`,
  );
  check(
    `${label}: fork chain has the same entries as the source up to the cut`,
    forkChain.length === cutTurn.lastIdx + 1 &&
      new Set(forkChain.map((m) => ff.get(m.uuid))).size === cutTurn.lastIdx + 1 &&
      chain.slice(0, cutTurn.lastIdx + 1).every((m) => [...ff.values()].includes(m.uuid)),
    `fork=${forkChain.length} want=${cutTurn.lastIdx + 1}`,
  );
  check(
    `${label}: no source uuid reused in the fork`,
    forkChain.every((m) => !chain.some((s) => s.uuid === m.uuid)),
  );

  const rows = rowsOf(id);
  const src = rowsOf(SOURCE_ID).filter((r) => r.seq < endSeq);
  check(
    `${label}: copied seq range`,
    JSON.stringify(rows.map((r) => r.seq)) === JSON.stringify(src.map((r) => r.seq)),
    `${rows.map((r) => r.seq)} vs ${src.map((r) => r.seq)}`,
  );
  check(
    `${label}: role / created_at / blocks copied verbatim`,
    rows.every(
      (r, i) =>
        r.role === src[i].role &&
        r.created_at === src[i].created_at &&
        r.blocks_json === src[i].blocks_json,
    ),
  );
  const allIds = db.prepare('SELECT id FROM messages').all().map((r) => r.id);
  check(
    `${label}: fresh, unique message ids`,
    rows.every((r) => !src.some((s) => s.id === r.id)) && new Set(allIds).size === allIds.length,
  );
  check(
    `${label}: copied fork points re-pointed at the fork's own entries`,
    rows.every((r, i) =>
      src[i].sdk_uuid == null
        ? r.sdk_uuid == null
        : r.sdk_uuid != null && ff.get(r.sdk_uuid) === src[i].sdk_uuid,
    ),
    JSON.stringify(rows.map((r) => [r.seq, r.sdk_uuid && ff.get(r.sdk_uuid)])),
  );

  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  check(
    `${label}: conversation row (folder, origin, backend, saved, title)`,
    row &&
      row.cwd === WS &&
      row.origin === 'local' &&
      row.backend === 'sdk' &&
      row.ephemeral === 0 &&
      row.title === 'Seeded original (rewind)',
    JSON.stringify(row),
  );
  check(`${label}: notebook copied`, readNotebook(id) === before.notes);
  check(`${label}: is now the folder's last conversation`, getWorkspace(WS)?.lastConversation?.id === id);
  const listed = conv.listConversationsForCwd(WS).find((c) => c.id === id);
  check(`${label}: listed in the folder as a stored conversation`, listed?.source === 'claude-chat');
  return id;
}

// ---- 1. assistant message ---------------------------------------------------
console.log('\n1. rewind to an assistant message: keeps everything through that answer');
// The last answered turn that is not the final turn, so something is cut off.
const asstTurn = [...answered].reverse().find((t) => t.k < turns.length - 1) ?? answered[0];
const asstFork = await checkFork(
  `asst@turn${asstTurn.k}`,
  await forkConversationAt(SOURCE_ID, `asst_src_${asstTurn.k}`),
  { cutTurn: asstTurn, endSeq: 10 * (asstTurn.k + 1), prefill: undefined },
);
// The first answer has the compaction divider recorded right behind it.
if (turns[0].lastUuid) {
  const firstFork = await checkFork(
    'asst@turn0',
    await forkConversationAt(SOURCE_ID, 'asst_src_0'),
    { cutTurn: turns[0], endSeq: 10, prefill: undefined },
  );
  check(
    'the divider recorded right after that answer came along',
    firstFork != null && rowsOf(firstFork).some((r) => r.role === 'system' && r.seq === 2),
  );
}

// ---- 2. user message --------------------------------------------------------
console.log('\n2. rewind to a user message: keeps everything before it, hands its text back');
const userTurn = turns.find((t) => t.k > 0 && turns[t.k - 1].lastUuid);
const userFork = await checkFork(
  `user@turn${userTurn.k}`,
  await forkConversationAt(SOURCE_ID, `user_src_${userTurn.k}`),
  { cutTurn: turns[userTurn.k - 1], endSeq: 10 * userTurn.k, prefill: userTurn.prompt },
);

// ---- 3. first message -------------------------------------------------------
console.log('\n3. rewind to the very first message: nothing to fork, just the text back');
{
  const filesBefore = transcriptFiles();
  const convsBefore = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const res = await forkConversationAt(SOURCE_ID, 'user_src_0');
  check('reports ok', res.ok === true, JSON.stringify(res));
  check('no conversation id', res.ok && res.conversationId === null);
  check('prefill is the first prompt', res.ok && res.prefill === turns[0].prompt);
  check('cwd / backend for the fresh conversation', res.ok && res.cwd === WS && res.backend === 'sdk');
  check('no transcript written', JSON.stringify(transcriptFiles()) === JSON.stringify(filesBefore));
  check(
    'no conversation row created',
    db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n === convsBefore,
  );
}

// ---- 4. a fork can itself be rewound ----------------------------------------
console.log('\n4. the copied fork points are live: the fork rewinds again');
{
  const forkRows = rowsOf(asstFork).filter((r) => r.role === 'assistant' && r.sdk_uuid);
  const target = forkRows[0];
  const res = await forkConversationAt(asstFork, target.id);
  check('fork of the fork reports ok', res.ok && typeof res.conversationId === 'string', JSON.stringify(res));
  if (res.ok && res.conversationId) {
    const ch = await sdk.getSessionMessages(res.conversationId, { dir: WS });
    const ffA = forkedFromOf(asstFork);
    const ffB = forkedFromOf(res.conversationId);
    check(
      'second fork ends at the same original entry',
      ffA.get(ffB.get(ch.at(-1).uuid)) === ffA.get(target.sdk_uuid),
    );
    check(
      'second fork is titled from the first',
      db.prepare('SELECT title FROM conversations WHERE id = ?').get(res.conversationId).title ===
        'Seeded original (rewind) (rewind)',
    );
  }
}

// ---- 5. refusals ------------------------------------------------------------
console.log('\n5. refusals change nothing');
{
  const filesBefore = transcriptFiles();
  const convsBefore = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const r1 = await forkConversationAt(SOURCE_ID, 'sys_src_0');
  check('system row is not-rewindable', !r1.ok && r1.reason === 'not-rewindable', JSON.stringify(r1));
  const r2 = await forkConversationAt(SOURCE_ID, 'no-such-message');
  check('unknown message is not-found', !r2.ok && r2.reason === 'not-found');
  const r3 = await forkConversationAt('00000000-0000-4000-8000-000000000000', 'user_src_0');
  check('unknown conversation is not-found', !r3.ok && r3.reason === 'not-found');
  const r4 = await forkConversationAt(asstFork, 'user_src_1');
  check("another conversation's message is not-found", !r4.ok && r4.reason === 'not-found');
  if (unanswered) {
    const r5 = await forkConversationAt(SOURCE_ID, `asst_src_${unanswered.k}`);
    check('answer without a fork point is not-rewindable', !r5.ok && r5.reason === 'not-rewindable');
    const next = turns[unanswered.k + 1];
    if (next) {
      const r6 = await forkConversationAt(SOURCE_ID, `user_src_${next.k}`);
      check(
        'user message after such an answer is not-rewindable',
        !r6.ok && r6.reason === 'not-rewindable',
      );
    }
  }
  const OC = 'ses_opencode_example';
  ensureConversation(OC, WS, Date.now(), { backend: 'opencode' });
  upsertMessage({ id: 'oc_u', conversationId: OC, role: 'user', seq: 0, createdAt: 1, blocks: [] });
  upsertMessage({ id: 'oc_a', conversationId: OC, role: 'assistant', seq: 1, createdAt: 1, blocks: [], sdkUuid: 'x' });
  const r7 = await forkConversationAt(OC, 'oc_a');
  check('opencode conversation is not-sdk', !r7.ok && r7.reason === 'not-sdk');
  check(
    'opencode messages are never flagged rewindable',
    getMessagesPage(OC, 50).messages.every((m) => m.rewindable === false),
  );
  check('no transcript written by any refusal', JSON.stringify(transcriptFiles()) === JSON.stringify(filesBefore));
  check(
    'no conversation row created by any refusal (bar the opencode fixture)',
    db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n === convsBefore + 1,
  );
}

// ---- 6. rollback ------------------------------------------------------------
console.log('\n6. a failing DB transaction removes the transcript it would have used');
{
  const filesBefore = transcriptFiles();
  const convsBefore = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const msgsBefore = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const notesBefore = db.prepare('SELECT COUNT(*) AS n FROM conversation_notes').get().n;
  const lastBefore = getWorkspace(WS)?.lastConversation?.id;
  // Fails on the LAST write of the transaction, so the conversation row and
  // every message copy are already in when it aborts.
  db.exec(`CREATE TRIGGER inject_fork_failure BEFORE INSERT ON conversation_notes
           BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const res = await forkConversationAt(SOURCE_ID, `asst_src_${asstTurn.k}`);
  db.exec('DROP TRIGGER inject_fork_failure');
  check('reports fork-failed', !res.ok && res.reason === 'fork-failed', JSON.stringify(res));
  check('the error detail is surfaced', !res.ok && /injected failure/.test(res.detail ?? ''));
  check('the new transcript was deleted', JSON.stringify(transcriptFiles()) === JSON.stringify(filesBefore), transcriptFiles().join(','));
  check('no conversation row left behind', db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n === convsBefore);
  check('no message rows left behind', db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === msgsBefore);
  check('no notebook row left behind', db.prepare('SELECT COUNT(*) AS n FROM conversation_notes').get().n === notesBefore);
  check("folder's last conversation untouched", getWorkspace(WS)?.lastConversation?.id === lastBefore);
}

// ---- 7. the original ----------------------------------------------------------
console.log('\n7. the original is untouched by all of the above');
check('original transcript byte-for-byte unchanged', sha(fs.readFileSync(srcPath)) === before.transcript);
check('original message rows unchanged', srcRows() === before.rows);
check('original conversation row unchanged', srcConvRow() === before.conv);
check('original notebook unchanged', readNotebook(SOURCE_ID) === before.notes);
check('the real source transcript was never modified', sha(fs.readFileSync(SOURCE)) === realSourceHash);

// ---- 8. display flags ---------------------------------------------------------
console.log('\n8. rewindable flags on paged messages');
{
  const page = getMessagesPage(SOURCE_ID, 200);
  const flag = (id) => page.messages.find((m) => m.id === id)?.rewindable;
  check('first user message is rewindable (prefill only)', flag('user_src_0') === true);
  for (const t of turns) {
    check(`turn ${t.k} answer rewindable iff it has a fork point`, flag(`asst_src_${t.k}`) === (t.lastUuid != null));
    if (t.k > 0) {
      check(
        `turn ${t.k} prompt rewindable iff the previous answer has one`,
        flag(`user_src_${t.k}`) === (turns[t.k - 1].lastUuid != null),
      );
    }
  }
  check('system rows carry no flag', page.messages.find((m) => m.id === 'sys_src_0')?.rewindable === undefined);
  // The previous answer is looked up past the page edge, not inferred from it.
  const tail = getMessagesPage(SOURCE_ID, 1, 10 * userTurn.k + 1);
  check(
    'a user row on its own page still sees the previous answer',
    tail.messages.length === 1 && tail.messages[0].id === `user_src_${userTurn.k}` && tail.messages[0].rewindable === true,
  );
}

// ---- 9. upsert never clears a fork point ---------------------------------------
console.log('\n9. upsertMessage keeps sdk_uuid unless given a new one');
{
  const C = userFork;
  const get = () => db.prepare("SELECT sdk_uuid, blocks_json FROM messages WHERE id = 'u9'").get();
  upsertMessage({ id: 'u9', conversationId: C, role: 'assistant', seq: 900, createdAt: 1, blocks: [] });
  check('insert without one stores NULL', get().sdk_uuid === null);
  upsertMessage({ id: 'u9', conversationId: C, role: 'assistant', seq: 900, createdAt: 1, blocks: [], sdkUuid: 'first' });
  check('upsert with one sets it', get().sdk_uuid === 'first');
  upsertMessage({ id: 'u9', conversationId: C, role: 'assistant', seq: 900, createdAt: 1, blocks: [{ type: 'text', id: 'x', text: 'y' }] });
  check('upsert without one keeps it (and still updates blocks)', get().sdk_uuid === 'first' && get().blocks_json.includes('"y"'));
  upsertMessage({ id: 'u9', conversationId: C, role: 'assistant', seq: 900, createdAt: 1, blocks: [], sdkUuid: null });
  check('upsert with null keeps it', get().sdk_uuid === 'first');
  upsertMessage({ id: 'u9', conversationId: C, role: 'assistant', seq: 900, createdAt: 1, blocks: [], sdkUuid: 'second' });
  check('upsert with a new one replaces it', get().sdk_uuid === 'second');
}

// ---- 10. path the app cannot address directly ----------------------------------
// A folder name with a dot: the CLI encodes it as '-', this app's
// sdkTranscriptPath keeps it — so the fork file is NOT where the primary
// forkedFrom read looks, which exercises the getSessionMessages fallback for
// the uuid mapping and deleteSession for the rollback.
console.log('\n10. folder whose transcript path only the SDK resolves (mapping fallback)');
{
  const WS2 = path.join(home, 'projects', 'beta.app');
  fs.mkdirSync(WS2, { recursive: true });
  touchWorkspace(WS2, Date.now());
  const sdkFolder = path.join(home, '.claude', 'projects', WS2.replace(/[^a-zA-Z0-9]/g, '-'));
  const ID2 = crypto.randomUUID();
  fs.mkdirSync(sdkFolder, { recursive: true });
  // Same content under a new session id, as the CLI would have it.
  fs.writeFileSync(
    path.join(sdkFolder, `${ID2}.jsonl`),
    fs.readFileSync(SOURCE, 'utf8').split(SOURCE_ID).join(ID2),
  );
  const chain2 = await sdk.getSessionMessages(ID2, { dir: WS2 });
  check('precondition: the SDK finds the session', chain2.length === chain.length);
  check('precondition: the app-side path does not exist', !fs.existsSync(sdkTranscriptPath(WS2, ID2)));
  ensureConversation(ID2, WS2, T0, { backend: 'sdk' });
  const t = asstTurn;
  for (const k of [0, t.k]) {
    upsertMessage({ id: `u2_${k}`, conversationId: ID2, role: 'user', seq: 10 * k, createdAt: 1, blocks: [{ type: 'text', id: 'x', text: 'p' }] });
    upsertMessage({ id: `a2_${k}`, conversationId: ID2, role: 'assistant', seq: 10 * k + 1, createdAt: 1, blocks: [], sdkUuid: turns[k].lastUuid && chain2[turns[k].lastIdx].uuid });
  }
  const res = await forkConversationAt(ID2, `a2_${t.k}`);
  check('fork reports ok', res.ok && typeof res.conversationId === 'string', JSON.stringify(res));
  if (res.ok && res.conversationId) {
    const fc = await sdk.getSessionMessages(res.conversationId, { dir: WS2 });
    const rows = rowsOf(res.conversationId).filter((r) => r.role === 'assistant');
    const byUuid = new Map(fc.map((m) => [m.uuid, m]));
    check(
      'copied fork points still mapped (by content) onto the fork',
      rows.length > 0 &&
        rows.every((r, i) => {
          const src = chain2.find((m) => m.uuid === rowsOf(ID2).filter((x) => x.role === 'assistant')[i].sdk_uuid);
          const mine = byUuid.get(r.sdk_uuid);
          return src && mine && JSON.stringify(src.message) === JSON.stringify(mine.message);
        }),
      JSON.stringify(rows.map((r) => r.sdk_uuid)),
    );
    check('fork chain ends at the mapped cut entry', fc.at(-1)?.uuid === rows.at(-1).sdk_uuid);
  }
  const files2 = fs.readdirSync(sdkFolder).sort();
  // A notebook to copy, so the rewind's last write is what trips the trigger.
  writeNotebook(ID2, 'n', 1);
  db.exec(`CREATE TRIGGER inject_fork_failure BEFORE INSERT ON conversation_notes
           BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const bad = await forkConversationAt(ID2, `a2_${t.k}`).catch((e) => ({ ok: false, reason: String(e) }));
  db.exec('DROP TRIGGER inject_fork_failure');
  check('rollback reports fork-failed', !bad.ok && bad.reason === 'fork-failed', JSON.stringify(bad));
  check(
    'rollback removed the transcript via the SDK',
    JSON.stringify(fs.readdirSync(sdkFolder).sort()) === JSON.stringify(files2),
  );
}

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} checks passed, ${failures.length} failed`,
);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
