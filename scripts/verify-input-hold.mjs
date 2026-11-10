// Checks the rules in src/lib/inputHold.ts — when the SDK input stream may be
// closed — and the hook scope in src/lib/subagentChoice.ts. These are the rules
// that stop a woken-up background task turn from having its tools cancelled with
// "The user doesn't want to take this action right now". Run:
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/verify-input-hold.mjs
import assert from 'node:assert/strict';
import {
  BACKGROUND_WORK_HOLD_MS,
  backgroundHoldMs,
  describeDuration,
  holdFloorMs,
  idleExpiryAction,
  liveBackgroundTasks,
  startsMainThreadWork,
} from '../src/lib/inputHold.ts';
import { SUBAGENT_SPAWN_MATCHER, SUBAGENT_SPAWN_TOOLS } from '../src/lib/subagentChoice.ts';

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`ok  ${name}`);
};

const HOUR = 3_600_000;

// ── how long background work is waited on ───────────────────────────────────
check('default hold is two hours', () => {
  assert.equal(BACKGROUND_WORK_HOLD_MS, 2 * HOUR);
  assert.equal(backgroundHoldMs({}), 2 * HOUR);
});

check('CLOUDCHAT_BACKGROUND_HOLD_MS overrides the hold', () => {
  assert.equal(backgroundHoldMs({ CLOUDCHAT_BACKGROUND_HOLD_MS: '45000' }), 45_000);
});

check('a junk, zero or negative override falls back to the default', () => {
  for (const bad of ['', 'abc', '0', '-5', 'NaN', 'Infinity', undefined]) {
    assert.equal(backgroundHoldMs({ CLOUDCHAT_BACKGROUND_HOLD_MS: bad }), 2 * HOUR, String(bad));
  }
});

check('no hold floor without background work, the full hold with it', () => {
  assert.equal(holdFloorMs(0, {}), 0);
  assert.equal(holdFloorMs(1, {}), 2 * HOUR);
  assert.equal(holdFloorMs(7, { CLOUDCHAT_BACKGROUND_HOLD_MS: '1000' }), 1000);
});

check('describeDuration reads naturally', () => {
  assert.equal(describeDuration(2 * HOUR), '2 hours');
  assert.equal(describeDuration(HOUR), '1 hour');
  assert.equal(describeDuration(45 * 60_000), '45 minutes');
  assert.equal(describeDuration(60_000), '1 minute');
  assert.equal(describeDuration(45_000), '45 seconds');
  assert.equal(describeDuration(1_000), '1 second');
  assert.equal(describeDuration(1), '1 second');
  assert.equal(describeDuration(90 * 60_000), '90 minutes');
  assert.equal(describeDuration(90_000), '90 seconds');
});

// ── what the idle-close timer does when it fires ─────────────────────────────
check('a turn in flight always defers, whatever else is going on', () => {
  assert.equal(idleExpiryAction({ turnInFlight: true, backgroundWork: 0 }), 'defer');
  assert.equal(idleExpiryAction({ turnInFlight: true, backgroundWork: 3 }), 'defer');
});

check('live background work is terminated, never half-closed', () => {
  assert.equal(idleExpiryAction({ turnInFlight: false, backgroundWork: 1 }), 'terminate');
});

check('genuinely idle closes the input', () => {
  assert.equal(idleExpiryAction({ turnInFlight: false, backgroundWork: 0 }), 'close');
});

// ── the live set, from the background_tasks_changed level signal ─────────────
check('liveBackgroundTasks maps id → type', () => {
  const m = liveBackgroundTasks({
    tasks: [
      { task_id: 'a', task_type: 'local_bash' },
      { task_id: 'b', task_type: 'local_agent' },
    ],
  });
  assert.deepEqual([...m], [
    ['a', 'local_bash'],
    ['b', 'local_agent'],
  ]);
});

check('ambient housekeeping tasks do not hold the stream', () => {
  const m = liveBackgroundTasks({
    tasks: [
      { task_id: 'a', task_type: 'local_bash', ambient: true },
      { task_id: 'b', task_type: 'local_bash', ambient: false },
      { task_id: 'c', task_type: 'local_bash' },
    ],
  });
  assert.deepEqual([...m.keys()], ['b', 'c']);
});

check('an empty or malformed list is an empty set, not a throw', () => {
  assert.equal(liveBackgroundTasks({ tasks: [] }).size, 0);
  assert.equal(liveBackgroundTasks({}).size, 0);
  assert.equal(liveBackgroundTasks({ tasks: 'nope' }).size, 0);
  assert.equal(liveBackgroundTasks({ tasks: null }).size, 0);
  assert.equal(
    liveBackgroundTasks({ tasks: [null, 7, 'x', {}, { task_id: 5 }, { task_id: 'ok' }] }).size,
    1,
  );
});

check('a task with no type is still counted, as unknown', () => {
  assert.equal(liveBackgroundTasks({ tasks: [{ task_id: 'a' }] }).get('a'), 'unknown');
});

// ── which SDK messages mean the main thread is working ───────────────────────
check('main-thread stream/assistant/user messages start work', () => {
  for (const type of ['stream_event', 'assistant', 'user']) {
    assert.equal(startsMainThreadWork({ type, parent_tool_use_id: null }), true, type);
    assert.equal(startsMainThreadWork({ type }), true, `${type} without a parent field`);
  }
});

check('a woken turn announces itself with system init', () => {
  assert.equal(startsMainThreadWork({ type: 'system', subtype: 'init' }), true);
});

check('subagent traffic is not the main turn', () => {
  for (const type of ['stream_event', 'assistant', 'user']) {
    assert.equal(startsMainThreadWork({ type, parent_tool_use_id: 'toolu_1' }), false, type);
  }
});

check('task lifecycle, status and result messages do not start work', () => {
  for (const subtype of [
    'task_started',
    'task_updated',
    'task_notification',
    'background_tasks_changed',
    'status',
    'compact_boundary',
  ]) {
    assert.equal(startsMainThreadWork({ type: 'system', subtype }), false, subtype);
  }
  assert.equal(startsMainThreadWork({ type: 'result' }), false);
  assert.equal(startsMainThreadWork({}), false);
});

// ── PreToolUse hooks must not depend on the stream for every tool ────────────
check('the spawn matcher names exactly the spawn tools', () => {
  assert.equal(SUBAGENT_SPAWN_MATCHER, 'Agent|Task');
  assert.deepEqual(SUBAGENT_SPAWN_MATCHER.split('|').sort(), [...SUBAGENT_SPAWN_TOOLS].sort());
});

check('the matcher selects spawn tools and nothing else (as an anchored regex)', () => {
  const re = new RegExp(`^(?:${SUBAGENT_SPAWN_MATCHER})$`);
  for (const yes of ['Agent', 'Task']) assert.ok(re.test(yes), yes);
  for (const no of ['Bash', 'Read', 'Write', 'Monitor', 'TaskStop', 'mcp__remote__bash', 'Agents']) {
    assert.ok(!re.test(no), no);
  }
});

console.log(`\nALL ${n} CHECKS PASSED`);
