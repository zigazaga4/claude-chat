// Checks the rules in src/lib/autoCompact.ts: which thresholds are valid, when
// the PostToolBatch hook halts a loop, and how the client chains compact →
// "Continue.". Run:
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/verify-auto-compact.mjs
import assert from 'node:assert/strict';
import {
  AUTO_COMPACT_CONTINUE_PROMPT,
  AUTO_COMPACT_MIN_TOKENS,
  AUTO_COMPACT_REARM_SHARE,
  autoCompactChoices,
  autoCompactLimit,
  buildAutoCompactHook,
  chainAutoCompact,
  normalizeAutoCompactAt,
} from '../src/lib/autoCompact.ts';
import { formatTokensCompact } from '../src/lib/formatTokens.ts';

let n = 0;
const check = (name, fn) => {
  const r = fn();
  if (r && typeof r.then === 'function') {
    return r.then(() => {
      n++;
      console.log(`ok  ${name}`);
    });
  }
  n++;
  console.log(`ok  ${name}`);
};

const M = 1_000_000;

// ── thresholds ───────────────────────────────────────────────────────────────
check('1M window offers 100k..900k in 50k steps', () => {
  const c = autoCompactChoices(M);
  assert.equal(c[0], 100_000);
  assert.equal(c.at(-1), 900_000);
  assert.equal(c.length, 17);
  assert.ok(c.includes(300_000));
  for (let i = 1; i < c.length; i++) assert.equal(c[i] - c[i - 1], 50_000);
});

check('200k window stops at 150k (limit 180k)', () => {
  assert.deepEqual(autoCompactChoices(200_000), [100_000, 150_000]);
});

check('a window too small to be worth it offers nothing', () => {
  assert.deepEqual(autoCompactChoices(100_000), []);
  assert.deepEqual(autoCompactChoices(64_000), []);
});

check('every offered value is itself accepted by the server-side check', () => {
  for (const w of [128_000, 200_000, 400_000, M, 1_048_576])
    for (const t of autoCompactChoices(w)) assert.equal(normalizeAutoCompactAt(t, w), t);
});

check('300000 is accepted on a 1M window', () =>
  assert.equal(normalizeAutoCompactAt(300_000, M), 300_000));

check('anything unusable normalises to off, never to a different number', () => {
  for (const bad of [undefined, null, '300000', NaN, Infinity, -5, 0, 99_999, {}, [], true])
    assert.equal(normalizeAutoCompactAt(bad, M), 0, String(bad));
  // above 90% of the window the CLI's own emergency compaction would win
  assert.equal(normalizeAutoCompactAt(autoCompactLimit(M) + 1, M), 0);
  assert.equal(normalizeAutoCompactAt(autoCompactLimit(M), M), autoCompactLimit(M));
});

check('a fractional threshold is floored, not rejected', () =>
  assert.equal(normalizeAutoCompactAt(300_000.9, M), 300_000));

check('a threshold valid on 1M is off on a 200k model', () =>
  assert.equal(normalizeAutoCompactAt(500_000, 200_000), 0));

check('minimum is the documented constant', () =>
  assert.equal(AUTO_COMPACT_MIN_TOKENS, 100_000));

check('token formatting matches the ring and the divider', () => {
  assert.equal(formatTokensCompact(300_000), '300k');
  assert.equal(formatTokensCompact(150_000), '150k');
  assert.equal(formatTokensCompact(12_500), '12.5k');
  assert.equal(formatTokensCompact(950), '950');
  assert.equal(formatTokensCompact(1_200_000), '1.2M');
});

// ── the hook ─────────────────────────────────────────────────────────────────
const mkHook = (over = {}) => {
  const state = { limit: 300_000, used: 310_000, busy: false, trips: [], ...over };
  const hook = buildAutoCompactHook({
    limit: () => state.limit,
    used: () => state.used,
    busy: () => state.busy,
    onTrip: (u, l) => state.trips.push([u, l]),
  });
  return { state, hook };
};
const batch = (extra = {}) => ({ hook_event_name: 'PostToolBatch', ...extra });

await check('halts the loop once the context reaches the threshold', async () => {
  const { state, hook } = mkHook();
  const r = await hook(batch());
  assert.equal(r.continue, false);
  assert.match(r.stopReason, /310000/);
  assert.deepEqual(state.trips, [[310_000, 300_000]]);
});

await check('halts at exactly the threshold (>=, not >)', async () => {
  const { hook } = mkHook({ used: 300_000 });
  assert.equal((await hook(batch())).continue, false);
});

await check('one token under the threshold keeps going', async () => {
  const { state, hook } = mkHook({ used: 299_999 });
  assert.deepEqual(await hook(batch()), { continue: true });
  assert.equal(state.trips.length, 0);
});

await check('off (0) never halts, however large the context', async () => {
  const { state, hook } = mkHook({ limit: 0, used: 900_000 });
  assert.deepEqual(await hook(batch()), { continue: true });
  assert.equal(state.trips.length, 0);
});

await check('no usage reading yet never halts', async () => {
  const { hook } = mkHook({ used: null });
  assert.deepEqual(await hook(batch()), { continue: true });
});

await check('a subagent batch is left alone even over the threshold', async () => {
  const { state, hook } = mkHook();
  assert.deepEqual(await hook(batch({ agent_id: 'agent-1' })), { continue: true });
  assert.equal(state.trips.length, 0);
});

await check('other hook events are ignored', async () => {
  const { hook } = mkHook();
  assert.deepEqual(await hook({ hook_event_name: 'PostToolUse' }), { continue: true });
  assert.deepEqual(await hook({}), { continue: true });
});

await check('background agents defer the halt instead of killing them', async () => {
  const { state, hook } = mkHook({ busy: true });
  assert.deepEqual(await hook(batch()), { continue: true });
  assert.equal(state.trips.length, 0);
  state.busy = false;
  assert.equal((await hook(batch())).continue, false);
});

await check('the threshold is read live: raised mid-run it stops halting, lowered it starts', async () => {
  const { state, hook } = mkHook({ limit: 300_000, used: 250_000 });
  assert.deepEqual(await hook(batch()), { continue: true });
  state.limit = 200_000;
  assert.equal((await hook(batch())).continue, false);
  state.limit = 400_000;
  assert.deepEqual(await hook(batch()), { continue: true });
});

// ── the client chain ─────────────────────────────────────────────────────────
const mkRun = (...outcomes) => {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    return outcomes[calls.length - 1];
  };
  return { calls, run };
};
const OK = { ran: true, aborted: false, compacted: true, postTokens: 20_000 };

await check('compacts first, then sends "Continue." on the same instance', async () => {
  const { calls, run } = mkRun(OK, { ran: true, aborted: false, compacted: false });
  const r = await chainAutoCompact(run, 'inst-1', 300_000);
  assert.deepEqual(r, { status: 'continued' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    prompt: '/compact',
    instanceId: 'inst-1',
    compact: true,
    autoTriggered: true,
  });
  assert.equal(calls[1].prompt, AUTO_COMPACT_CONTINUE_PROMPT);
  assert.equal(calls[1].prompt, 'Continue.');
  assert.equal(calls[1].instanceId, 'inst-1');
  assert.equal(calls[1].suppressAutoCompact, false);
  assert.notEqual(calls[1].compact, true);
});

for (const [name, out, reason] of [
  ['refused to start', { ran: false, aborted: false, compacted: false }, 'not-run'],
  ['stopped by the user mid-compaction', { ran: true, aborted: true, compacted: true }, 'aborted'],
  ['finished without a compact boundary', { ran: true, aborted: false, compacted: false }, 'no-boundary'],
]) {
  await check(`no "Continue." when the compaction ${name}`, async () => {
    const { calls, run } = mkRun(out);
    assert.deepEqual(await chainAutoCompact(run, 'i', 300_000), { status: 'stopped', reason });
    assert.equal(calls.length, 1);
  });
}

await check('a compaction that leaves the context too full continues with auto-compact off', async () => {
  const over = 300_000 * AUTO_COMPACT_REARM_SHARE + 1;
  const { calls, run } = mkRun({ ...OK, postTokens: over }, OK);
  await chainAutoCompact(run, 'i', 300_000);
  assert.equal(calls[1].suppressAutoCompact, true);
});

await check('exactly at the re-arm share still re-arms', async () => {
  const { calls, run } = mkRun({ ...OK, postTokens: 300_000 * AUTO_COMPACT_REARM_SHARE }, OK);
  await chainAutoCompact(run, 'i', 300_000);
  assert.equal(calls[1].suppressAutoCompact, false);
});

await check('an unreported post-compaction size does not disable auto-compact', async () => {
  const { calls, run } = mkRun({ ...OK, postTokens: undefined }, OK);
  await chainAutoCompact(run, 'i', 300_000);
  assert.equal(calls[1].suppressAutoCompact, false);
});

console.log(`\nALL ${n} CHECKS PASSED`);
