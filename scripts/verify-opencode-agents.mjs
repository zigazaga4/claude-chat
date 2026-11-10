// Checks the OpenCode agent roster (src/server/opencode/subagentChoice.ts) —
// the pairings the assistant chooses between when it launches an agent.
// Pure part always runs. With --live it also asks a real OpenCode server what
// reasoning levels each model offers and checks the roster against it (needs
// the provider keys in the environment and `opencode` on PATH).
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/verify-opencode-agents.mjs [--live]
import assert from 'node:assert/strict';
import { MODELS, getProvider } from '../src/lib/models.ts';
import { supportsBackend } from '../src/lib/backends.ts';
import { opencodeModelId, qualifiedModel } from '../src/server/opencode/providers.ts';
import {
  agentConfigFor,
  buildAgentChoiceBlock,
  buildAgentRoster,
  readVariants,
} from '../src/server/opencode/subagentChoice.ts';

const env = {};
let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`ok  ${name}`);
};
const wire = (id) => opencodeModelId(id, env);

// ---- levels given as data
check('deepseek: every offered level up to the ceiling, never max, low→high order', () => {
  const r = buildAgentRoster(
    'deepseek-v4-pro',
    { [wire('deepseek-v4-pro')]: ['max', 'high', 'low'], [wire('deepseek-flash')]: ['low', 'high', 'max'] },
    env,
  );
  assert.deepEqual(
    r.map((e) => e.agent),
    ['general-ds-v4-pro-low', 'general-ds-v4-pro-high', 'general-ds-v4-1-flash-low', 'general-ds-v4-1-flash-high'],
  );
  assert.ok(r.every((e) => e.effort !== 'max'));
  assert.ok(r.filter((e) => e.model === 'deepseek-flash').every((e) => e.lightweight));
  assert.ok(r.filter((e) => e.model === 'deepseek-v4-pro').every((e) => !e.lightweight));
});

check('qwen: a model with its own level names keeps them (low, medium, xhigh)', () => {
  const r = buildAgentRoster('qwen3.8-max', { [wire('qwen3.8-max')]: ['low', 'medium', 'xhigh'] }, env);
  assert.deepEqual(r.map((e) => e.effort), ['low', 'medium', 'xhigh']);
});

check('a model with no adjustable levels is offered once, at its default', () => {
  const r = buildAgentRoster('glm-5.3', { [wire('glm-5.3')]: [] }, env);
  assert.deepEqual(r.map((e) => [e.agent, e.effort]), [['general-glm-5-3', null]]);
});

check('a model whose only levels are above the ceiling is not offered at all', () => {
  assert.deepEqual(buildAgentRoster('glm-5.3', { [wire('glm-5.3')]: ['max'] }, env), []);
});

check('an unrecognised level name is not offered', () => {
  const r = buildAgentRoster('glm-5.3', { [wire('glm-5.3')]: ['low', 'turbo'] }, env);
  assert.deepEqual(r.map((e) => e.effort), ['low']);
});

check('discovery failed (null): each model once at default, no level names invented', () => {
  const r = buildAgentRoster('deepseek-v4-pro', null, env);
  assert.deepEqual(r.map((e) => e.effort), [null, null]);
});

check('openrouter roster covers only openrouter models that OpenCode can run', () => {
  const r = buildAgentRoster('moonshotai/kimi-k3', null, env);
  const ids = new Set(r.map((e) => e.model));
  for (const id of ids) {
    assert.equal(getProvider(id), 'openrouter');
    assert.ok(supportsBackend(id, 'opencode'));
  }
  assert.ok(!ids.has('anthropic/claude-haiku-5.5'), 'Claude must never be on the OpenCode roster');
});

check('agent names are unique across the whole registry', () => {
  // One roster per provider (any of its models yields the same one); names only
  // have to be unique within a roster, since a stream serves a single provider.
  const seen = new Set();
  for (const m of MODELS.filter((x) => supportsBackend(x.id, 'opencode'))) {
    const provider = getProvider(m.id);
    if (seen.has(provider)) continue;
    seen.add(provider);
    const names = buildAgentRoster(m.id, null, env).map((e) => e.agent);
    assert.equal(new Set(names).size, names.length, `${provider}: ${names.join(', ')}`);
  }
});

// ---- borrowing levels for synthesised ids
const lv = (...names) => Object.fromEntries(names.map((n) => [n, { reasoning: { effort: n } }]));
check('an empty preset id borrows the plain slug\'s levels (GLM Flash on OpenRouter)', () => {
  const p = readVariants({ 'z-ai/glm-5.3-flash': { variants: lv('low', 'high', 'max') }, [wire('z-ai/glm-5.3-flash')]: { variants: {} } }, 'openrouter', env);
  assert.deepEqual(p.levels[wire('z-ai/glm-5.3-flash')], ['low', 'high', 'max']);
  assert.deepEqual(p.inherited[wire('z-ai/glm-5.3-flash')], lv('low', 'high', 'max'));
});

check('levels OpenCode derived for a synthesised id are left alone (DeepSeek preset)', () => {
  const p = readVariants(
    {
      'deepseek/deepseek-v4.1-flash': { variants: lv('none', 'low', 'high', 'max') },
      [wire('deepseek/deepseek-v4.1-flash')]: { variants: lv('low', 'medium', 'high') },
    },
    'openrouter',
    env,
  );
  assert.deepEqual(p.levels[wire('deepseek/deepseek-v4.1-flash')], ['low', 'medium', 'high']);
  assert.ok(!(wire('deepseek/deepseek-v4.1-flash') in p.inherited));
});

check('a plain id with no levels borrows nothing (wire id is the slug itself)', () => {
  const p = readVariants({ [wire('glm-5.3')]: { variants: {} } }, 'zai', env);
  assert.deepEqual(p.levels[wire('glm-5.3')], []);
  assert.deepEqual(p.inherited, {});
});

check('a synthesised id whose slug has no levels either stays empty', () => {
  const p = readVariants({ 'z-ai/glm-5.3-flash': { variants: {} } }, 'openrouter', env);
  assert.deepEqual(p.levels[wire('z-ai/glm-5.3-flash')], []);
  assert.deepEqual(p.inherited, {});
});

check('borrowed levels still pass through the ceiling (max never offered)', () => {
  const p = readVariants({ 'z-ai/glm-5.3-flash': { variants: lv('low', 'high', 'max') } }, 'openrouter', env);
  const r = buildAgentRoster('z-ai/glm-5.3-flash', p.levels, env).filter((e) => e.model === 'z-ai/glm-5.3-flash');
  assert.deepEqual(r.map((e) => e.effort), ['low', 'high']);
});

// ---- the server config
check('config pins model + variant on each pairing and switches general off', () => {
  const r = buildAgentRoster('qwen3.8-max', { [wire('qwen3.8-max')]: ['low', 'xhigh', 'max'] }, env);
  const cfg = agentConfigFor(r, { QWEN_API_KEY: 'x' });
  assert.deepEqual(cfg.general, { disable: true });
  assert.equal(cfg['general-qwen-3-8-low'].variant, 'low');
  assert.equal(cfg['general-qwen-3-8-xhigh'].variant, 'xhigh');
  assert.equal(cfg['general-qwen-3-8-low'].mode, 'subagent');
  assert.equal(cfg['general-qwen-3-8-low'].model, qualifiedModel('qwen3.8-max', env));
  assert.ok(!('general-qwen-3-8-max' in cfg));
});

check('a default-level pairing pins no variant', () => {
  const cfg = agentConfigFor(buildAgentRoster('glm-5.3', null, env), env);
  assert.ok(!('variant' in cfg['general-glm-5-3']));
});

check('an empty roster leaves the built-in general agent alone', () => {
  assert.deepEqual(agentConfigFor([], env), {});
  assert.equal(buildAgentChoiceBlock([]), '');
});

// ---- the prompt
check('prompt lists every pairing and states the ceiling', () => {
  const r = buildAgentRoster(
    'deepseek-v4-pro',
    { [wire('deepseek-v4-pro')]: ['low', 'high', 'max'], [wire('deepseek-flash')]: ['low', 'high'] },
    env,
  );
  const b = buildAgentChoiceBlock(r);
  for (const e of r) assert.ok(b.includes(`\`${e.agent}\``), e.agent);
  assert.match(b, /max, is not offered/);
  assert.match(b, /lighter model/);
  assert.match(b, /standing instruction/);
  assert.ok(!/general-ds-v4-pro-max/.test(b));
});

check('a single-model, no-level provider gets no model/level advice', () => {
  const b = buildAgentChoiceBlock(buildAgentRoster('glm-5.3', { [wire('glm-5.3')]: [] }, env));
  assert.ok(!/lighter model/.test(b));
  assert.ok(!/raise the reasoning level/.test(b));
  assert.match(b, /`general-glm-5-3`/);
});

// ---- live
if (process.argv.includes('--live')) {
  const { createOpencodeServer, createOpencodeClient } = await import('@opencode-ai/sdk');
  const { buildProviderConfig, buildEnabledProviders, registryProviderId } = await import(
    '../src/server/opencode/providers.ts'
  );
  const liveEnv = { ...process.env };
  for (const k of ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'QWEN_API_KEY'])
    liveEnv[k] ||= 'fake';
  let port = 45940;
  for (const p of ['deepseek', 'openrouter', 'zai', 'moonshot', 'qwen']) {
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port: port++,
      config: {
        logLevel: 'ERROR',
        provider: buildProviderConfig(p, liveEnv),
        enabled_providers: buildEnabledProviders(p),
        autoupdate: false,
        share: 'disabled',
      },
      timeout: 60_000,
    });
    try {
      const client = createOpencodeClient({ baseUrl: server.url });
      const res = await client.config.providers();
      const entry = res.data.providers.find((x) => x.id === registryProviderId(p));
      const modelOfProvider = MODELS.find((m) => getProvider(m.id) === p && supportsBackend(m.id, 'opencode'));
      // The same function the app uses, so this checks what ships.
      const { levels: variants, inherited } = readVariants(entry?.models, p, liveEnv);
      const roster = buildAgentRoster(modelOfProvider.id, variants, liveEnv);
      const cfg = agentConfigFor(roster, liveEnv);
      // Every pinned level must exist on the live model, or OpenCode would
      // silently ignore it and the agent would run at the provider default.
      // (A borrowed level is checked below, against the server that declares it.)
      for (const e of roster) {
        if (!e.effort) continue;
        const w = opencodeModelId(e.model, liveEnv);
        const live = entry.models[w]?.variants ?? inherited[w] ?? {};
        assert.ok(e.effort in live || e.effort in (inherited[w] ?? {}), `${p}/${e.agent}: ${e.effort} not offered live`);
        assert.notEqual(e.effort, 'max');
      }
      // And a server given the agent block must expose exactly those agents,
      // keep each pinned model and level, and have dropped the built-in general.
      const withAgents = await createOpencodeServer({
        hostname: '127.0.0.1',
        port: port++,
        config: {
          logLevel: 'ERROR',
          provider: buildProviderConfig(p, liveEnv, inherited),
          enabled_providers: buildEnabledProviders(p),
          agent: cfg,
          autoupdate: false,
          share: 'disabled',
        },
        timeout: 60_000,
      });
      try {
        const agents = (await createOpencodeClient({ baseUrl: withAgents.url }).app.agents()).data;
        const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
        assert.ok(!('general' in byName), `${p}: built-in general should be disabled`);
        assert.ok('explore' in byName, `${p}: explore should remain`);
        for (const e of roster) {
          const a = byName[e.agent];
          assert.ok(a, `${p}: ${e.agent} missing from the live server`);
          assert.equal(a.mode, 'subagent');
          assert.equal(a.variant ?? null, e.effort, `${p}/${e.agent}: variant`);
        }
      } finally {
        withAgents.close();
      }
      n++;
      console.log(`ok  live ${p}: ${roster.length} pairings [${roster.map((e) => e.agent).join(', ')}]`);
    } finally {
      server.close();
    }
  }
}

console.log(`\nALL ${n} CHECKS PASSED`);
