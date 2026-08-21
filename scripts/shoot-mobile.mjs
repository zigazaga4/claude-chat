/**
 * Drive headless Chromium over the DevTools Protocol to screenshot the app at
 * phone size, signed in, with a chosen element clicked first.
 *
 * Exists because `--screenshot` can only capture a cold page load: it cannot
 * log in, and it cannot open the mobile drawer, which is the one piece of
 * mobile UI most worth looking at. Node 24 ships a global WebSocket, so this
 * needs no dependencies.
 *
 *   node scripts/shoot-mobile.mjs <baseUrl> <password> <out.png> [clickSelector]
 */

const [, , base, password, out, clickSelector] = process.argv;
if (!base || !password || !out) {
  console.error('usage: shoot-mobile.mjs <baseUrl> <password> <out.png> [selector]');
  process.exit(2);
}

const DEBUG_PORT = process.env.CDP_PORT || '9333';

/** Poll until Chromium's debugging endpoint answers. */
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chromium DevTools endpoint never came up');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');

// A real phone viewport, including the device pixel ratio — `--window-size`
// alone leaves deviceScaleFactor at 1 and misses DPR-dependent layout.
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
// Makes `@media (hover: none)` and `(pointer: coarse)` match, which is what
// gates most of the mobile CSS. Without it this would screenshot the desktop
// rules at a narrow width and prove nothing.
await send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'hover', value: 'none' },
    { name: 'pointer', value: 'coarse' },
    { name: 'any-hover', value: 'none' },
    { name: 'any-pointer', value: 'coarse' },
  ],
});

// Sign in by calling the login endpoint from a page already on the origin, so
// the Set-Cookie lands on the right origin without hand-forging a cookie.
await send('Page.navigate', { url: `${base}/login` });
await wait(2500);
const login = await send('Runtime.evaluate', {
  awaitPromise: true,
  returnByValue: true,
  expression: `fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.status)`,
});
console.log('  login status:', login.result.value);

await send('Page.navigate', { url: `${base}/` });
await wait(3500);

if (clickSelector) {
  const clicked = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (!el) return 'NOT FOUND'; el.click(); return 'clicked'; })()`,
  });
  console.log('  click', clickSelector, '->', clicked.result.value);
  await wait(1200);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('  wrote', out);

/*
 * Shut the browser down from the inside.
 *
 * Killing it from the shell afterwards does not work: only the root process
 * carries `--remote-debugging-port`, so a `pkill -f` on that pattern leaves
 * every `--type=gpu-process` and `--type=renderer` child alive. Headless
 * Chromium falls back to swiftshader for WebGL, and those orphans then spin at
 * over 100% CPU each, indefinitely. Three forgotten runs added up to 107 live
 * processes and 1.4 GB before anyone noticed the machine stuttering.
 *
 * `Browser.close` tears down the whole tree, which is the only cleanup that
 * actually holds.
 */
try {
  await send('Browser.close');
} catch {
  // Already gone, or too old to support it — fall through to the hard exit.
}
ws.close();
process.exit(0);
