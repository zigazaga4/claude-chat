/**
 * Electron shell for claude chat.
 *
 * The app's whole backend is a Node.js Next.js server (better-sqlite3 + node-pty
 * + ssh2 + the Claude Agent SDK spawning the `claude` CLI). Rather than port any
 * of that, this shell just RUNS the production Next server as a child process on
 * a free localhost port and points a BrowserWindow at it — the desktop window is
 * a thin native frame over the same web app.
 *
 * The server is spawned with SYSTEM Node (not Electron-as-Node) so the native
 * modules keep their existing ABI — identical to how the app runs under pm2, so
 * no electron-rebuild is needed for this build. Packaging a distributable later
 * is where bundling Node / rebuilding natives for Electron's ABI comes in.
 */

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

// Project root — one level up from this file (electron/).
const ROOT = path.join(__dirname, '..');
const SERVER_START_TIMEOUT_MS = 60_000;

let serverProc = null;

/** Ask the OS for an unused localhost port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn `next start` on the given port using system Node, so the app's native
 * modules load exactly as they do outside Electron. Streams server logs to the
 * Electron stdout/stderr for debugging.
 */
function startServer(port) {
  // Resolve Next's CLI entry from the app's own node_modules.
  const nextBin = require.resolve('next/dist/bin/next', { paths: [ROOT] });
  const nodeBin = process.env.CLAUDE_CHAT_NODE || 'node';
  const proc = spawn(nodeBin, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  proc.on('exit', (code, signal) =>
    console.log(`[server] exited code=${code} signal=${signal}`),
  );
  proc.on('error', (err) => console.error('[server] spawn error:', err.message));
  return proc;
}

/** Poll the server until it answers an HTTP request (or we give up). */
function waitForServer(port, timeoutMs = SERVER_START_TIMEOUT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Next server did not become ready within ${timeoutMs}ms`));
      } else {
        setTimeout(attempt, 300);
      }
    };
    attempt();
  });
}

function errorPage(message) {
  const safe = String(message).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      `<html><body style="background:#0a0a0a;color:#e5e5e5;font-family:system-ui;padding:40px;line-height:1.6">
        <h2>claude chat couldn't start its server</h2>
        <p>${safe}</p>
        <p style="color:#a3a3a3">Make sure you've built the app first:</p>
        <pre style="background:#171717;padding:12px;border-radius:8px">NODE_ENV= npm run build</pre>
      </body></html>`,
    )
  );
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.once('ready-to-show', () => win.show());

  // Open target=_blank / external links in the user's real browser, not a
  // new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    const port = await findFreePort();
    serverProc = startServer(port);
    await waitForServer(port);
    await win.loadURL(`http://127.0.0.1:${port}`);
  } catch (err) {
    await win.loadURL(errorPage(err instanceof Error ? err.message : String(err)));
    win.show();
  }
}

function killServer() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    serverProc = null;
  }
}

// Single-instance: focus the existing window instead of spawning a 2nd server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', killServer);
  process.on('exit', killServer);
}
