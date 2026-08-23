/**
 * End-to-end check of moveConversation against a throwaway database and a
 * throwaway HOME, so the real ~/.cloudchat and ~/.claude/projects are never
 * touched.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *         scripts/verify-move-conversation.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-move-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(home, { recursive: true });
// os.homedir() reads $HOME on POSIX, which is what decides where the CLI
// transcript folders live.
process.env.HOME = home;
process.env.CLAUDE_CHAT_DB_PATH = path.join(sandbox, 'test.db');

const { getDb } = await import('../src/server/db.ts');
const {
  ensureConversation,
  moveConversation,
  listConversationsForCwd,
  upsertMessage,
  sdkTranscriptPath,
} = await import('../src/server/conversations.ts');
const { touchWorkspace, upsertSshWorkspace, getWorkspace } = await import(
  '../src/server/workspaces.ts'
);

const db = getDb();

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

const LOCAL_A = path.join(home, 'projects', 'alpha');
const LOCAL_B = path.join(home, 'projects', 'beta');
const SSH_ONE = 'ssh://root@10.0.0.1/srv/app';
const SSH_TWO = 'ssh://root@10.0.0.2:2222/srv/other';

for (const p of [LOCAL_A, LOCAL_B]) fs.mkdirSync(p, { recursive: true });
touchWorkspace(LOCAL_A, Date.now());
touchWorkspace(LOCAL_B, Date.now());
upsertSshWorkspace({ cwd: SSH_ONE });
upsertSshWorkspace({ cwd: SSH_TWO });

/** Create a conversation with a message and a transcript on disk. */
function seed(id, cwd, { withTranscript = true, body = 'x' } = {}) {
  ensureConversation(id, cwd, Date.now(), { backend: 'sdk' });
  upsertMessage({
    id: `m_${id}`,
    conversationId: id,
    role: 'user',
    seq: 0,
    createdAt: Date.now(),
    blocks: [{ type: 'text', text: body }],
  });
  if (withTranscript) {
    const sdkCwd = cwd.startsWith('ssh://') ? home : cwd;
    const p = sdkTranscriptPath(sdkCwd, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `{"sessionId":"${id}","marker":"${body}"}\n`);
    return p;
  }
  return null;
}

const row = (id) =>
  db.prepare('SELECT cwd, origin, updated_at FROM conversations WHERE id = ?').get(id);
const msgCount = (id) =>
  db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(id).n;

console.log('\n1. local -> local: transcript follows the row');
{
  const id = 'conv-local-to-local';
  const src = seed(id, LOCAL_A, { body: 'alpha-history' });
  const before = row(id).updated_at;

  const res = moveConversation(id, LOCAL_B);
  check('move reports ok', res.ok === true, JSON.stringify(res));
  check('reports the transcript moved', res.ok && res.transcriptMoved === true);
  check('row now points at B', row(id).cwd === LOCAL_B, row(id).cwd);
  check('origin stays local', row(id).origin === 'local');
  check('updated_at is not bumped', row(id).updated_at === before);
  check('old transcript is gone', !fs.existsSync(src));

  const dst = sdkTranscriptPath(LOCAL_B, id);
  check('new transcript exists', fs.existsSync(dst));
  check(
    'transcript content is intact',
    fs.existsSync(dst) && fs.readFileSync(dst, 'utf8').includes('alpha-history'),
  );
  check('messages survive the move', msgCount(id) === 1);
  check(
    'A no longer lists it',
    !listConversationsForCwd(LOCAL_A).some((c) => c.id === id),
  );
  check('B lists it', listConversationsForCwd(LOCAL_B).some((c) => c.id === id));
}

console.log('\n2. local -> ssh: transcript lands in the home folder, origin flips');
{
  const id = 'conv-local-to-ssh';
  const src = seed(id, LOCAL_A);
  const res = moveConversation(id, SSH_ONE);
  check('move reports ok', res.ok === true, JSON.stringify(res));
  check('origin becomes ssh', row(id).origin === 'ssh');
  check('row points at the ssh uri', row(id).cwd === SSH_ONE);
  check('old transcript is gone', !fs.existsSync(src));
  check(
    'transcript is now under HOME',
    fs.existsSync(sdkTranscriptPath(home, id)),
  );
  check(
    'the home folder does not leak it into a local listing',
    !listConversationsForCwd(home).some((c) => c.id === id),
  );
}

console.log('\n3. ssh -> ssh: no file touched, because both run from HOME');
{
  const id = 'conv-ssh-to-ssh';
  const src = seed(id, SSH_ONE);
  const mtimeBefore = fs.statSync(src).mtimeMs;
  const res = moveConversation(id, SSH_TWO);
  check('move reports ok', res.ok === true, JSON.stringify(res));
  check('reports no transcript move', res.ok && res.transcriptMoved === false);
  check('row points at the second host', row(id).cwd === SSH_TWO);
  check('origin stays ssh', row(id).origin === 'ssh');
  check('the file was left alone', fs.statSync(src).mtimeMs === mtimeBefore);
}

console.log('\n4. ssh -> local: transcript comes back out of HOME');
{
  const id = 'conv-ssh-to-local';
  const src = seed(id, SSH_ONE, { body: 'remote-history' });
  const res = moveConversation(id, LOCAL_B);
  check('move reports ok', res.ok === true, JSON.stringify(res));
  check('reports the transcript moved', res.ok && res.transcriptMoved === true);
  check('origin becomes local', row(id).origin === 'local');
  check('old transcript is gone', !fs.existsSync(src));
  const dst = sdkTranscriptPath(LOCAL_B, id);
  check(
    'transcript is in the local folder with its content',
    fs.existsSync(dst) && fs.readFileSync(dst, 'utf8').includes('remote-history'),
  );
  check('B lists it', listConversationsForCwd(LOCAL_B).some((c) => c.id === id));
}

console.log('\n5. refusals leave everything untouched');
{
  const id = 'conv-refusals';
  const src = seed(id, LOCAL_A);

  const unknown = moveConversation(id, path.join(home, 'projects', 'nope'));
  check('unknown destination refused', unknown.ok === false);
  check(
    'refusal reason is unknown-destination',
    !unknown.ok && unknown.reason === 'unknown-destination',
    !unknown.ok ? unknown.reason : '',
  );

  const same = moveConversation(id, LOCAL_A);
  check('same workspace refused', !same.ok && same.reason === 'same-workspace');

  const missing = moveConversation('does-not-exist', LOCAL_B);
  check('missing conversation refused', !missing.ok && missing.reason === 'not-found');

  check('row untouched after refusals', row(id).cwd === LOCAL_A);
  check('transcript untouched after refusals', fs.existsSync(src));
}

console.log('\n6. a destination transcript with the same id is never overwritten');
{
  const id = 'conv-collision';
  const src = seed(id, LOCAL_A, { body: 'the-real-one' });
  // Plant a decoy where the move would land.
  const dst = sdkTranscriptPath(LOCAL_B, id);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, 'decoy');

  const res = moveConversation(id, LOCAL_B);
  check('refused', !res.ok && res.reason === 'transcript-conflict');
  check('row untouched', row(id).cwd === LOCAL_A);
  check('source transcript untouched', fs.readFileSync(src, 'utf8').includes('the-real-one'));
  check('destination decoy untouched', fs.readFileSync(dst, 'utf8') === 'decoy');
}

console.log('\n7. a CLI session with no row is adopted, not dead-ended');
{
  const id = 'conv-external-session';
  // Only a transcript — exactly what `claude` leaves behind on its own.
  const src = sdkTranscriptPath(LOCAL_A, id);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, `{"sessionId":"${id}","marker":"external"}\n`);

  check(
    'it shows up in A as an external session first',
    listConversationsForCwd(LOCAL_A).some((c) => c.id === id && c.source === 'sdk'),
  );
  check('no row exists yet', row(id) === undefined);

  const res = moveConversation(id, LOCAL_B, { fromCwd: LOCAL_A });
  check('move reports ok', res.ok === true, JSON.stringify(res));
  check('a row now exists, in B', row(id)?.cwd === LOCAL_B);
  check('adopted as an sdk conversation', db
    .prepare('SELECT backend FROM conversations WHERE id = ?')
    .get(id).backend === 'sdk');
  check('transcript moved', fs.existsSync(sdkTranscriptPath(LOCAL_B, id)) && !fs.existsSync(src));
  check('B lists it', listConversationsForCwd(LOCAL_B).some((c) => c.id === id));
  check(
    'A no longer lists it',
    !listConversationsForCwd(LOCAL_A).some((c) => c.id === id),
  );

  const bogus = moveConversation('never-existed-anywhere', LOCAL_B, { fromCwd: LOCAL_A });
  check(
    'a claimed source with no transcript is still not-found',
    !bogus.ok && bogus.reason === 'not-found',
  );
}

console.log("\n8. the source folder stops advertising it as its last conversation");
{
  const id = 'conv-last-pointer';
  seed(id, LOCAL_A);
  check(
    'A points at it before the move',
    getWorkspace(LOCAL_A)?.lastConversation?.id === id,
  );
  const res = moveConversation(id, LOCAL_B);
  check('move reports ok', res.ok === true);
  check(
    'A has let go of it',
    getWorkspace(LOCAL_A)?.lastConversation?.id !== id,
    String(getWorkspace(LOCAL_A)?.lastConversation?.id),
  );

  // A conversation that is NOT the pointer must not clear someone else's.
  const keeper = 'conv-a-keeper';
  seed(keeper, LOCAL_A);
  const other = 'conv-mover';
  seed(other, LOCAL_A);
  // `other` was seeded last, so it holds the pointer; put it back on `keeper`.
  db.prepare('UPDATE workspaces SET last_conversation_id = ? WHERE cwd = ?').run(
    keeper,
    LOCAL_A,
  );
  moveConversation(other, LOCAL_B);
  check(
    "an unrelated move leaves the folder's pointer alone",
    getWorkspace(LOCAL_A)?.lastConversation?.id === keeper,
  );
}

console.log('\n9. an opencode conversation moves without any file at all');
{
  const id = 'ses_opencode_example';
  ensureConversation(id, LOCAL_A, Date.now(), { backend: 'opencode' });
  const res = moveConversation(id, SSH_TWO);
  check('move reports ok', res.ok === true, JSON.stringify(res));
  check('reports no transcript move', res.ok && res.transcriptMoved === false);
  check('row points at the remote', row(id).cwd === SSH_TWO);
  check(
    'backend is untouched',
    db.prepare('SELECT backend FROM conversations WHERE id = ?').get(id).backend ===
      'opencode',
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
