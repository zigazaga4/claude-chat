// Checks the built-in WhatsApp MCP server end to end, without needing an account:
// the bundled-server plumbing in the MCP registry, the three tools through a real
// MCP client, recipient resolution and the send guards (against a fake socket),
// and — with --live — that a real Baileys socket reaches WhatsApp and produces a
// QR code. Runs against a throwaway HOME, so the real database is never touched.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/verify-whatsapp.mjs [--live]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.argv.includes('--live');

// Everything below must see the throwaway HOME, so set it before any import.
const fakeHome = fs.mkdtempSync(path.join(os.homedir(), '.cc-wa-verify-'));
process.env.HOME = fakeHome;
process.env.CLOUDCHAT_WHATSAPP_HOURLY_CAP = '4';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const registry = await import('../src/server/mcpRegistry.ts');
const connector = await import('../src/server/mcpConnector.ts');
const wa = await import('../src/server/whatsapp.ts');
const { getDb } = await import('../src/server/db.ts');

let n = 0;
const check = async (name, fn) => {
  await fn();
  n++;
  console.log(`ok  ${name}`);
};

/** Connect an MCP client to a server instance over a linked in-memory pair. */
async function clientFor(instance) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await instance.connect(s);
  const client = new Client({ name: 'verify', version: '0' });
  await client.connect(c);
  return client;
}
const text = (r) => r.content.map((b) => b.text ?? '').join('\n');

const CWD = '/home/verify/project';

try {
  // ── the bundled server is in the registry, and off ────────────────────────
  await check('whatsapp is seeded as a bundled entry', () => {
    const e = registry.getMcpServer('whatsapp');
    assert.ok(e, 'seeded');
    assert.equal(e.transport, 'bundled');
    assert.equal(e.enabled, true);
    assert.equal(e.command, 'whatsapp');
  });

  await check('it is attached to NO folder by default', () => {
    assert.deepEqual(registry.listServersForWorkspace(CWD), []);
    assert.deepEqual(registry.listWorkspacesForServer(registry.getMcpServer('whatsapp').id), []);
  });

  await check('a user definition cannot shadow or fake a bundled server', () => {
    assert.throws(
      () => registry.upsertMcpServer({ name: 'whatsapp', transport: 'http', url: 'http://x/mcp' }),
      /built-in/,
    );
    assert.throws(
      () => registry.upsertMcpServer({ name: 'sneaky', transport: 'bundled', command: 'whatsapp' }),
      /built-in/,
    );
  });

  // ── attach through the management tools, as an agent would ────────────────
  const manager = connector.createMcpManagerServer({ workspaceCwd: CWD, isRemote: false, style: 'sdk' });
  const mgr = await clientFor(manager.instance);

  await check('mcp list offers whatsapp in the library, not as live', async () => {
    const out = text(await mgr.callTool({ name: 'list', arguments: {} }));
    assert.match(out, /Live here: none/);
    assert.match(out, /whatsapp — built in/);
  });

  await check('mcp remove refuses to delete a built-in server', async () => {
    const r = await mgr.callTool({ name: 'remove', arguments: { name: 'whatsapp' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /built into cloudchat/);
    assert.ok(registry.getMcpServer('whatsapp'), 'still there');
  });

  await check('mcp connect cannot redefine it', async () => {
    const r = await mgr.callTool({
      name: 'connect',
      arguments: { name: 'whatsapp', transport: 'local-stdio', command: 'echo hi' },
    });
    assert.equal(r.isError, true);
    assert.match(text(r), /built-in/);
  });

  await check('mcp attach switches it on for this folder and reports its tools', async () => {
    const r = await mgr.callTool({ name: 'attach', arguments: { name: 'whatsapp' } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /3 tool\(s\): status, find_chat, send_message/);
    assert.equal(registry.listServersForWorkspace(CWD).length, 1);
    assert.deepEqual(registry.listServersForWorkspace('/home/verify/other'), []);
  });

  // ── the tools, through the exact proxy both engines use ───────────────────
  const entry = registry.listServersForWorkspace(CWD)[0];
  const proxy = connector.proxyMcpServerFactory(entry)();
  const tools = await clientFor(proxy.instance);

  await check('proxy lists the three tools with real input schemas', async () => {
    const { tools: list } = await tools.listTools();
    assert.deepEqual(list.map((t) => t.name).sort(), ['find_chat', 'send_message', 'status']);
    const send = list.find((t) => t.name === 'send_message');
    assert.deepEqual([...send.inputSchema.required].sort(), ['text', 'to']);
  });

  await check('unlinked: status says how to link, send refuses', async () => {
    const st = text(await tools.callTool({ name: 'status', arguments: {} }));
    assert.match(st, /NOT linked/);
    const r = await tools.callTool({ name: 'send_message', arguments: { to: 'me', text: 'hi' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /not linked/i);
  });

  // ── name lookup ───────────────────────────────────────────────────────────
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO whatsapp_contacts (jid, name, push, kind, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  ins.run('40711000001@s.whatsapp.net', 'Ștefan Popescu', null, 'contact', now);
  ins.run('40711000002@s.whatsapp.net', 'Stefan Ionescu', null, 'contact', now);
  ins.run('40711000003@s.whatsapp.net', 'Maria', null, 'contact', now);
  ins.run('99999999999@lid', 'Maria', null, 'contact', now); // same person, LID form
  ins.run('120363000000@g.us', 'Familia', null, 'group', now);
  ins.run('40711000004@s.whatsapp.net', null, 'Andrei the Pusher', 'contact', now);

  await check('findChats ignores case and diacritics', () => {
    assert.equal(wa.findChats('stefan').length, 2);
    assert.equal(wa.findChats('ȘTEFAN').length, 2);
    assert.equal(wa.findChats('ionescu')[0].number, '40711000002');
  });

  await check('findChats collapses a person who arrived as LID and phone JID', () => {
    const m = wa.findChats('maria');
    assert.equal(m.length, 1);
    assert.equal(m[0].jid, '40711000003@s.whatsapp.net');
  });

  await check('findChats finds groups and self-chosen (push) names', () => {
    assert.equal(wa.findChats('famil')[0].kind, 'group');
    assert.equal(wa.findChats('pusher')[0].number, '40711000004');
    assert.deepEqual(wa.findChats('nobody-by-this-name'), []);
  });

  // ── sending, against a fake socket ────────────────────────────────────────
  const sess = globalThis.__cc_whatsapp__;
  const sent = [];
  const presence = [];
  let failNext = false;
  const fakeSock = {
    onWhatsApp: async (jid) => [{ jid, exists: !jid.startsWith('40999') }],
    sendPresenceUpdate: async (kind, jid) => void presence.push([kind, jid]),
    sendMessage: async (jid, content) => {
      if (failNext) {
        failNext = false;
        throw new Error('rate-overlimit');
      }
      sent.push({ at: Date.now(), jid, text: content.text });
      return { key: { id: `ID${sent.length}` } };
    },
    groupFetchAllParticipating: async () => ({}),
    end() {},
    logout: async () => {},
  };
  Object.assign(sess, {
    sock: fakeSock,
    socketState: 'open',
    meLoaded: true,
    me: { jid: '40700000000@s.whatsapp.net', name: 'Leo' },
  });

  await check('status reflects a linked account', async () => {
    const st = text(await tools.callTool({ name: 'status', arguments: {} }));
    assert.match(st, /Linked as \+40700000000 \(Leo\)/);
    assert.match(st, /Sent this hour: 0 of 4/);
  });

  await check('"me" sends to the account itself, with typing presence around it', async () => {
    const r = await wa.sendWhatsAppText({ to: 'me', text: 'note to self' });
    assert.equal(r.jid, '40700000000@s.whatsapp.net');
    assert.equal(sent.at(-1).text, 'note to self');
    assert.deepEqual(presence.map((p) => p[0]), ['composing', 'paused']);
  });

  await check('a phone number is normalised, and verified to exist on WhatsApp', async () => {
    const r = await wa.sendWhatsAppText({ to: '+40 722 123 456', text: 'hello' });
    assert.equal(r.jid, '40722123456@s.whatsapp.net');
    assert.equal(r.label, '+40722123456');
  });

  const before = sent.length;
  await check('a number without country code is refused, not guessed', async () => {
    await assert.rejects(wa.sendWhatsAppText({ to: '0722123456', text: 'x' }), /country code/);
  });
  await check('a number that is not on WhatsApp is refused', async () => {
    await assert.rejects(wa.sendWhatsAppText({ to: '+40999000111', text: 'x' }), /not registered/);
  });
  await check('a name matching two people sends NOTHING and lists both', async () => {
    await assert.rejects(
      wa.sendWhatsAppText({ to: 'Stefan', text: 'x' }),
      (e) => /more than one chat/.test(e.message) && /40711000001/.test(e.message) && /40711000002/.test(e.message),
    );
  });
  await check('an unknown name is refused with a hint', async () => {
    await assert.rejects(wa.sendWhatsAppText({ to: 'Nobody Here', text: 'x' }), /No contact or group/);
  });
  await check('empty and oversized text are refused', async () => {
    await assert.rejects(wa.sendWhatsAppText({ to: 'me', text: '   ' }), /empty/);
    await assert.rejects(wa.sendWhatsAppText({ to: 'me', text: 'a'.repeat(4001) }), /4000/);
  });
  await check('none of the refusals reached the socket', () => {
    assert.equal(sent.length, before);
  });

  await check('a unique name resolves (LID duplicate does not make it ambiguous)', async () => {
    const r = await wa.sendWhatsAppText({ to: 'Maria', text: 'salut' });
    assert.equal(r.jid, '40711000003@s.whatsapp.net');
  });

  await check('concurrent sends are serialised and spaced', async () => {
    const a = wa.sendWhatsAppText({ to: 'familia', text: 'one' });
    const b = wa.sendWhatsAppText({ to: 'me', text: 'two' }).catch((e) => e);
    await Promise.all([a, b]);
    // 4 sends so far = the cap of 4: the second of this pair is refused.
    const ok = sent.filter((s) => s.text === 'one' || s.text === 'two');
    assert.equal(ok.length, 1, 'cap of 4 allows exactly one of the pair');
    assert.equal(ok[0].jid, '120363000000@g.us');
  });

  await check('the hourly cap refuses further sends and says why', async () => {
    await assert.rejects(wa.sendWhatsAppText({ to: 'me', text: 'over' }), /Hourly send limit/);
  });

  await check('send gaps are at least the minimum spacing', () => {
    for (let i = 1; i < sent.length; i++) {
      assert.ok(sent[i].at - sent[i - 1].at >= 2400, `gap ${i}: ${sent[i].at - sent[i - 1].at}ms`);
    }
  });

  await check('a WhatsApp-side failure is surfaced and logged as failed', async () => {
    db.prepare(`DELETE FROM whatsapp_sends`).run(); // reset the cap window
    failNext = true;
    await assert.rejects(wa.sendWhatsAppText({ to: 'me', text: 'will fail' }), /refused the message: rate-overlimit/);
    const last = wa.recentSends(1)[0];
    assert.equal(last.ok, false);
    assert.match(last.error, /rate-overlimit/);
    // A failed send does not count against the cap.
    assert.equal((await wa.getWhatsAppStatus()).sendsLastHour, 0);
  });

  await check('send_message through MCP returns the resolved recipient', async () => {
    const r = await tools.callTool({ name: 'send_message', arguments: { to: 'Maria', text: 'via mcp' } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /Sent to Maria/);
  });

  await check('send_message through MCP turns ambiguity into an error the model can act on', async () => {
    const r = await tools.callTool({ name: 'send_message', arguments: { to: 'Stefan', text: 'x' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Ask the user which one/);
  });

  await check('find_chat through MCP lists matches', async () => {
    const r = await tools.callTool({ name: 'find_chat', arguments: { query: 'stefan' } });
    assert.match(text(r), /Ștefan Popescu — \+40711000001/);
    assert.match(text(r), /Stefan Ionescu — \+40711000002/);
  });

  await check('the audit log keeps what was sent, in order', () => {
    const rows = wa.recentSends(10);
    assert.equal(rows[0].body, 'via mcp');
    assert.ok(rows.every((r) => typeof r.at === 'number'));
  });

  // Detach the fake socket before the live section.
  Object.assign(sess, { sock: null, socketState: 'closed', meLoaded: false, me: null });
  db.prepare(`DELETE FROM whatsapp_auth`).run();

  await check('detach removes it from the folder again', async () => {
    const r = await mgr.callTool({ name: 'detach', arguments: { name: 'whatsapp' } });
    assert.ok(!r.isError, text(r));
    assert.deepEqual(registry.listServersForWorkspace(CWD), []);
    assert.ok(registry.getMcpServer('whatsapp'), 'definition survives');
  });

  // ── a real socket: does WhatsApp hand us a QR? ────────────────────────────
  if (LIVE) {
    await check('LIVE: pairing opens a socket and produces a QR code', async () => {
      await wa.beginPairing();
      let st;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        st = await wa.getWhatsAppStatus();
        if (st.qr) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.ok(st.qr, `no QR within 25s (error: ${st?.error})`);
      assert.equal(st.pairing, true);
      assert.equal(st.linked, false);
      assert.ok(st.qr.length > 100);
      console.log(`    QR payload ${st.qr.length} chars, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
    });

    await check('LIVE: cancelling pairing leaves nothing behind', async () => {
      wa.cancelPairing();
      const st = await wa.getWhatsAppStatus();
      assert.equal(st.pairing, false);
      assert.equal(st.qr, null);
      assert.equal(st.socket, 'closed');
      assert.equal(st.error, null, 'cancelling is not an error');
      // Let the rejected connect settle; it must not set an error afterwards.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await wa.getWhatsAppStatus()).error, null);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_auth`).get().n, 0);
    });
  } else {
    console.log('--  live socket checks skipped (pass --live)');
  }

  console.log(`\n${n} checks passed`);
} finally {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
