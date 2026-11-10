// Checks the rules in src/lib/subagentChoice.ts that the Agent-call hook and
// the tool card both depend on. Run:
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/verify-subagent-choice.mjs
import assert from 'node:assert/strict';
import {
  SUBAGENT_MODEL_TIERS,
  buildSubagentChoiceBlock,
  buildSubagentChoiceHook,
  capSubagentEffort,
  resolveSubagentSpawn,
} from '../src/lib/subagentChoice.ts';

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`ok  ${name}`);
};

const base = { description: 'd', prompt: 'p', subagent_type: 'general-purpose' };

check('tiers are exactly haiku/sonnet/opus', () =>
  assert.deepEqual([...SUBAGENT_MODEL_TIERS], ['haiku', 'sonnet', 'opus']));

check('cap leaves low..xhigh alone and lowers max', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh']) assert.equal(capSubagentEffort(e), e);
  assert.equal(capSubagentEffort('max'), 'xhigh');
});

for (const model of SUBAGENT_MODEL_TIERS)
  check(`model ${model} is allowed untouched`, () =>
    assert.deepEqual(resolveSubagentSpawn({ ...base, model }, 'high'), { action: 'allow' }));

check('fable is denied with a usable reason', () => {
  const d = resolveSubagentSpawn({ ...base, model: 'fable' }, 'high');
  assert.equal(d.action, 'deny');
  assert.match(d.reason, /haiku, sonnet, opus/);
});

check('explicit max becomes xhigh and the rest of the input survives', () => {
  const d = resolveSubagentSpawn({ ...base, model: 'opus', effort: 'max' }, 'low');
  assert.equal(d.action, 'rewrite');
  assert.deepEqual(d.input, { ...base, model: 'opus', effort: 'xhigh' });
  assert.match(d.notes.join(' '), /"max".*"xhigh"/);
});

for (const e of ['low', 'medium', 'high', 'xhigh'])
  check(`explicit ${e} is allowed untouched`, () =>
    assert.deepEqual(resolveSubagentSpawn({ ...base, effort: e }, 'max'), { action: 'allow' }));

check('omitted effort + turn at max is capped to xhigh', () => {
  const d = resolveSubagentSpawn({ ...base, model: 'sonnet' }, 'max');
  assert.equal(d.action, 'rewrite');
  assert.equal(d.input.effort, 'xhigh');
});

for (const turn of ['low', 'medium', 'high', 'xhigh', null])
  check(`omitted effort + turn at ${turn} is left to inherit`, () =>
    assert.deepEqual(resolveSubagentSpawn(base, turn), { action: 'allow' }));

check('higher from xhigh stays at xhigh, never max', () => {
  const d = resolveSubagentSpawn({ ...base, effort: 'higher' }, 'xhigh');
  assert.equal(d.input.effort, 'xhigh');
});
check('higher from max is capped', () =>
  assert.equal(resolveSubagentSpawn({ ...base, effort: 'higher' }, 'max').input.effort, 'xhigh'));
check('lower steps down and floors at low', () => {
  assert.equal(resolveSubagentSpawn({ ...base, effort: 'lower' }, 'high').input.effort, 'medium');
  assert.equal(resolveSubagentSpawn({ ...base, effort: 'lower' }, 'low').input.effort, 'low');
});
check('relative with unknown turn effort assumes high', () =>
  assert.equal(resolveSubagentSpawn({ ...base, effort: 'higher' }, null).input.effort, 'xhigh'));

// ---- the hook wrapper
const hook = buildSubagentChoiceHook('max');
const run = (input) => hook(input);

{
  const r = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(r, { continue: true });
  n++; console.log('ok  hook ignores non-Agent tools');
}
{
  const r = await run({ tool_name: 'Agent', agent_id: 'sub1', tool_input: { ...base, effort: 'max' } });
  assert.deepEqual(r, { continue: true });
  n++; console.log('ok  hook ignores calls made from inside a subagent');
}
{
  const r = await run({ tool_name: 'Task', tool_input: { ...base, effort: 'max' } });
  assert.equal(r.hookSpecificOutput.updatedInput.effort, 'xhigh');
  assert.equal(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  n++; console.log('ok  hook rewrites max on the legacy Task name too');
}
{
  const r = await run({ tool_name: 'Agent', tool_input: { ...base, model: 'fable' } });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  n++; console.log('ok  hook denies fable');
}
{
  const r = await run({ tool_name: 'Agent', tool_input: undefined });
  assert.equal(r.hookSpecificOutput.updatedInput.effort, 'xhigh'); // turn is max, nothing given
  n++; console.log('ok  hook tolerates a missing tool_input');
}

check('prompt block names every tier and the limits', () => {
  const b = buildSubagentChoiceBlock();
  for (const t of SUBAGENT_MODEL_TIERS) assert.match(b, new RegExp(`\`${t}\``));
  assert.match(b, /xhigh/);
  assert.match(b, /`max` is not available/);
  assert.match(b, /fable/);
  assert.ok(!/\d\.\d/.test(b), 'prompt must not pin version numbers that will go stale');
});

console.log(`\nALL ${n} CHECKS PASSED`);
