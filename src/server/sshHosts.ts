/**
 * Pooled SSH hosts. One Connection per (user, host, port, identity) tuple,
 * shared across all consumers (chat tools, the Shell tab, the SFTP folder
 * picker). Lives on globalThis so dev-mode HMR keeps long-running sessions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  Client,
  type AgentAuthMethod,
  type ClientChannel,
  type ConnectConfig,
  type PasswordAuthMethod,
  type PublicKeyAuthMethod,
  type SFTPWrapper,
} from 'ssh2';

/**
 * Concrete auth strategies we hand to ssh2's `authHandler`. The base
 * `AuthMethod` interface only defines `type` + `username`; each concrete
 * variant adds its own payload (`key`, `agent`, `password`).
 */
type ConcreteAuthMethod =
  | AgentAuthMethod
  | PublicKeyAuthMethod
  | PasswordAuthMethod;

export type ConnectOpts = {
  host: string;
  port: number;
  user: string;
  identityPath?: string | null;
  /** Use SSH agent (SSH_AUTH_SOCK) for auth. */
  useAgent?: boolean;
  /** Optional password (used only if no key/agent works). */
  password?: string;
  /** TOFU pin: refuse to connect if the server fingerprint differs. */
  expectedHostFingerprint?: string | null;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
};

const READY_TIMEOUT_MS = 15_000;
const KEEPALIVE_MS = 20_000;

export class RemoteHost {
  readonly key: string;
  readonly opts: ConnectOpts;
  private client: Client | null = null;
  private ready: Promise<void> | null = null;
  /** Locks SFTP creation so we hand out a single shared SFTP per host. */
  private sftpHandle: SFTPWrapper | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  private hostFingerprint: string | null = null;
  /** Human-readable list of auth methods offered on the last connect. */
  private lastAttempted: string[] = [];
  closed = false;

  constructor(opts: ConnectOpts) {
    this.opts = opts;
    this.key = makeKey(opts);
  }

  async connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.doConnect();
    try {
      await this.ready;
    } catch (err) {
      this.ready = null; // allow retry
      throw err;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;

      const cfg: ConnectConfig = {
        host: this.opts.host,
        port: this.opts.port,
        username: this.opts.user,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_MS,
        keepaliveCountMax: 3,
        // Pin or capture the host fingerprint (TOFU).
        hostVerifier: (key: Buffer | string) => {
          const buf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
          const fp = sha256Fingerprint(buf);
          this.hostFingerprint = fp;
          if (this.opts.expectedHostFingerprint) {
            return fp === this.opts.expectedHostFingerprint;
          }
          return true;
        },
      };

      // Build the auth strategy. We use ssh2's `authHandler` array form so
      // we can offer the agent + every plausible key + (optionally) a
      // password, in priority order. ssh2 walks the array until one method
      // succeeds. This is what mirrors a working terminal `ssh user@host`
      // for users who have ~/.ssh/config entries or non-default key names.
      const methods: ConcreteAuthMethod[] = [];
      const attemptedLabels: string[] = [];

      // Explicit caller intent comes first.
      let explicitKey: Buffer | null = null;
      if (this.opts.identityPath) {
        try {
          explicitKey = fs.readFileSync(this.opts.identityPath);
        } catch (e) {
          reject(
            new Error(
              `Cannot read identity file at ${this.opts.identityPath}: ${
                e instanceof Error ? e.message : 'unknown'
              }`,
            ),
          );
          return;
        }
        methods.push({
          type: 'publickey',
          username: this.opts.user,
          key: explicitKey,
        });
        attemptedLabels.push(`key ${this.opts.identityPath}`);
      }

      const agentSock = process.env.SSH_AUTH_SOCK;
      if (this.opts.useAgent) {
        if (!agentSock) {
          reject(new Error('useAgent requested but SSH_AUTH_SOCK is not set'));
          return;
        }
        methods.push({
          type: 'agent',
          username: this.opts.user,
          agent: agentSock,
        });
        attemptedLabels.push('ssh-agent');
      }

      if (this.opts.password) {
        methods.push({
          type: 'password',
          username: this.opts.user,
          password: this.opts.password,
        });
        attemptedLabels.push('password');
      }

      // Auto-discovery: when nothing was explicitly requested, walk what
      // `ssh` would walk. Always offer the agent (if reachable), then every
      // private key under ~/.ssh — keys from matching ~/.ssh/config entries
      // first, then the four canonical names, then anything else that looks
      // like a private key. ssh2 will try each in turn.
      const noExplicit = methods.length === 0;
      if (noExplicit) {
        if (agentSock) {
          methods.push({
            type: 'agent',
            username: this.opts.user,
            agent: agentSock,
          });
          attemptedLabels.push('ssh-agent');
        }
        const discovered = discoverIdentityCandidates(this.opts.host);
        for (let i = 0; i < discovered.buffers.length; i++) {
          methods.push({
            type: 'publickey',
            username: this.opts.user,
            key: discovered.buffers[i],
          });
          attemptedLabels.push(`key ${discovered.paths[i]}`);
        }
      }

      if (methods.length === 0) {
        reject(
          new Error(
            'No SSH credentials available. Set up an SSH key in ~/.ssh, ' +
              'start an SSH agent, or sign in with a password.',
          ),
        );
        return;
      }

      cfg.authHandler = methods;

      // Remember what we tried so the error path can be specific instead of
      // ssh2's generic "All configured authentication methods failed".
      this.lastAttempted = attemptedLabels;

      // Diagnostic: print what we're offering. Shows up in `npm run dev`'s
      // console — invaluable when the agent isn't reaching the Next.js
      // process (common when the dev server was started outside the user's
      // login shell or in a tmux session without agent forwarding).
      console.log(
        `[ssh] connect ${this.opts.user}@${this.opts.host}:${this.opts.port} — ` +
          `SSH_AUTH_SOCK=${agentSock ? agentSock : '(not set)'} — ` +
          `auth: ${attemptedLabels.join(', ')}`,
      );

      // CRITICAL: use `.on('error', …)` not `.once`. ssh2 emits *additional*
      // errors after the first one (notably "Connection lost before
      // handshake" from gnome-keyring's ssh-agent shim mis-signing ed25519).
      // A `once` listener detaches itself after firing, leaving the next
      // error unhandled — which Node escalates to uncaughtException and pm2
      // promptly kills the whole process. Re-using `.on` plus a settled
      // guard means we report the first failure to the caller and silently
      // absorb any follow-up emissions instead of crashing the server.
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      client.on('ready', settleResolve);
      client.on('error', (err) => {
        const original = err instanceof Error ? err.message : String(err);
        // Log every error (even post-settle) so we can see follow-ups in
        // the pm2 logs without crashing the process.
        console.log(
          `[ssh] error ${this.opts.user}@${this.opts.host}:${this.opts.port} — ${original}`,
        );
        if (/all configured authentication methods failed/i.test(original)) {
          const tried = this.lastAttempted.length
            ? this.lastAttempted.join(', ')
            : '(none)';
          const agentHint = agentSock
            ? ''
            : ' Note: SSH_AUTH_SOCK is not set in the server process, so the ' +
              'ssh-agent was not used — restart the dev server from a shell ' +
              'where `echo $SSH_AUTH_SOCK` prints a path.';
          settleReject(
            new Error(
              `SSH auth failed for ${this.opts.user}@${this.opts.host}. ` +
                `Tried: ${tried}.${agentHint}`,
            ),
          );
          return;
        }
        // Protocol-level errors (handshake lost, parse failures) come
        // through here too. Surface them with context.
        settleReject(
          err instanceof Error
            ? new Error(
                `SSH connection to ${this.opts.user}@${this.opts.host}:${this.opts.port} failed: ${err.message}`,
              )
            : new Error(String(err)),
        );
      });
      client.on('close', () => {
        // Mark closed + drop handles. If the connection died before
        // resolving (e.g. handshake lost), settle the promise as a
        // rejection so the route returns a real error instead of hanging.
        this.closed = true;
        this.sftpHandle = null;
        this.sftpPromise = null;
        this.client = null;
        this.ready = null;
        settleReject(
          new Error(
            `SSH connection to ${this.opts.user}@${this.opts.host}:${this.opts.port} closed before becoming ready.`,
          ),
        );
      });

      try {
        client.connect(cfg);
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  getHostFingerprint(): string | null {
    return this.hostFingerprint;
  }

  async exec(command: string, opts?: { stdin?: string }): Promise<ExecResult> {
    await this.connect();
    const client = this.client!;
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        let signal: string | null = null;
        stream.on('data', (chunk: Buffer | string) => {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        stream.on('exit', (c: number | null, s: string | null) => {
          code = c;
          signal = s ?? null;
        });
        stream.on('close', () => {
          resolve({ stdout, stderr, code, signal });
        });
        stream.on('error', reject);
        if (opts?.stdin != null) {
          stream.end(opts.stdin);
        }
      });
    });
  }

  /** Open a streaming exec channel — caller pumps chunks. */
  streamExec(
    command: string,
    handlers: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      onExit?: (code: number | null, signal: string | null) => void;
    },
  ): Promise<void> {
    return this.connect().then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.client!.exec(command, (err, stream) => {
            if (err) {
              reject(err);
              return;
            }
            stream.on('data', (chunk: Buffer | string) => {
              handlers.onStdout?.(
                typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
              );
            });
            stream.stderr.on('data', (chunk: Buffer | string) => {
              handlers.onStderr?.(
                typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
              );
            });
            stream.on('exit', (c: number | null, s: string | null) => {
              handlers.onExit?.(c, s ?? null);
            });
            stream.on('close', () => resolve());
            stream.on('error', reject);
          });
        }),
    );
  }

  async sftp(): Promise<SFTPWrapper> {
    await this.connect();
    if (this.sftpHandle) return this.sftpHandle;
    if (this.sftpPromise) return this.sftpPromise;
    this.sftpPromise = new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          this.sftpPromise = null;
          reject(err);
          return;
        }
        sftp.on('close', () => {
          this.sftpHandle = null;
          this.sftpPromise = null;
        });
        this.sftpHandle = sftp;
        resolve(sftp);
      });
    });
    return this.sftpPromise;
  }

  async openShell(opts: {
    cols: number;
    rows: number;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<ClientChannel> {
    await this.connect();
    return new Promise((resolve, reject) => {
      this.client!.shell(
        {
          cols: opts.cols,
          rows: opts.rows,
          term: 'xterm-256color',
        },
        { env: opts.env as NodeJS.ProcessEnv | undefined },
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          // If a working dir was requested, cd into it before yielding to the
          // user. We send a single command followed by `clear` so the user
          // doesn't see the cd preamble in their scrollback.
          if (opts.cwd) {
            const safe = opts.cwd.replace(/'/g, `'\\''`);
            stream.write(`cd '${safe}' 2>/dev/null && clear\n`);
          }
          resolve(stream);
        },
      );
    });
  }

  close(): void {
    if (!this.client) return;
    try {
      this.client.end();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.ready = null;
    this.sftpHandle = null;
    this.sftpPromise = null;
    this.closed = true;
  }
}

function makeKey(opts: ConnectOpts): string {
  return [
    opts.user,
    opts.host,
    opts.port,
    opts.identityPath ?? '',
    opts.useAgent ? 'agent' : '',
  ].join('|');
}

function sha256Fingerprint(key: Buffer): string {
  // Mirror what `ssh-keygen -lf` prints: SHA256:<base64>
  // Done lazily via Node crypto.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const b64 = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

// ---- SSH config + key discovery -----------------------------------------
//
// `ssh` consults ~/.ssh/config and considers every key file under ~/.ssh/,
// not just the four well-known names. The ssh2 library doesn't do any of
// that for us. To match what the user sees when they `ssh user@host` from a
// terminal, we have to read the config ourselves, expand IdentityFile
// directives for the matching host, and offer them through the authHandler.

type SshConfigBlock = {
  hostPatterns: string[];
  identityFiles: string[];
};

function parseSshConfig(text: string): SshConfigBlock[] {
  const blocks: SshConfigBlock[] = [];
  let current: SshConfigBlock | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0]?.toLowerCase();
    if (!keyword) continue;
    if (keyword === 'host') {
      if (current) blocks.push(current);
      current = { hostPatterns: parts.slice(1), identityFiles: [] };
    } else if (current && keyword === 'identityfile') {
      const value = parts.slice(1).join(' ').replace(/^"(.*)"$/, '$1');
      if (value) current.identityFiles.push(value);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function matchHostPattern(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern === host) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  // Convert ssh's glob ("*", "?") to a regex.
  const escaped = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      if (/[.+^${}()|[\]\\]/.test(ch)) return '\\' + ch;
      return ch;
    })
    .join('');
  return new RegExp('^' + escaped + '$').test(host);
}

function expandHomePath(p: string, home: string): string {
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p === '~') return home;
  return p;
}

function looksLikePrivateKey(data: Buffer): boolean {
  // Inspect the first chunk only — private keys begin with one of the well-
  // known PEM headers (OpenSSH, RSA, DSA, EC, encrypted).
  const head = data.subarray(0, 80).toString('utf8');
  return /-----BEGIN (?:OPENSSH|RSA|DSA|EC|ENCRYPTED) PRIVATE KEY-----/.test(
    head,
  );
}

const SSH_DIR_SKIP = new Set([
  'config',
  'known_hosts',
  'known_hosts.old',
  'authorized_keys',
  'authorized_keys2',
  'environment',
  'rc',
  'agent.env',
]);

/**
 * Walk the things `ssh user@host` would walk to find a key, in priority
 * order: matching `IdentityFile` entries in ~/.ssh/config → well-known
 * default names → anything else in ~/.ssh/ that parses as a private key.
 * De-duplicated by absolute path so we never try the same file twice.
 */
function discoverIdentityCandidates(host: string): {
  paths: string[];
  buffers: Buffer[];
} {
  const home = os.homedir();
  const sshDir = path.join(home, '.ssh');
  const seen = new Set<string>();
  const paths: string[] = [];
  const buffers: Buffer[] = [];

  const tryFile = (absPath: string) => {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return;
      // Private keys are small — skip multi-MB junk that happens to live in
      // ~/.ssh/ (e.g. cached known_hosts variants).
      if (stat.size > 64 * 1024) return;
      const data = fs.readFileSync(absPath);
      if (!looksLikePrivateKey(data)) return;
      paths.push(absPath);
      buffers.push(data);
    } catch {
      /* unreadable — skip */
    }
  };

  // 1. ~/.ssh/config — IdentityFile entries for the matching Host blocks.
  try {
    const cfgText = fs.readFileSync(path.join(sshDir, 'config'), 'utf8');
    for (const block of parseSshConfig(cfgText)) {
      if (!block.hostPatterns.some((p) => matchHostPattern(p, host))) continue;
      for (const idFile of block.identityFiles) {
        tryFile(expandHomePath(idFile, home));
      }
    }
  } catch {
    /* no config file — fine */
  }

  // 2. Well-known default key names.
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']) {
    tryFile(path.join(sshDir, name));
  }

  // 3. Everything else in ~/.ssh/. Catches users with `id_rsa_work` and the
  //    like — `ssh` itself would only pick these up via the config, but a lot
  //    of real setups also have `IdentitiesOnly no` and rely on the agent
  //    plus opportunistic key offering. Mirroring that here is the only way
  //    to be at parity with the terminal in the common case.
  try {
    for (const name of fs.readdirSync(sshDir)) {
      if (name.endsWith('.pub')) continue;
      if (SSH_DIR_SKIP.has(name)) continue;
      if (name.startsWith('known_hosts')) continue;
      tryFile(path.join(sshDir, name));
    }
  } catch {
    /* no ~/.ssh dir — fine */
  }

  return { paths, buffers };
}

// ---- Pool ----------------------------------------------------------------

type Pool = Map<string, RemoteHost>;
const POOL_KEY = '__cc_sshHostPool__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[POOL_KEY]) g[POOL_KEY] = new Map<string, RemoteHost>();
const pool = g[POOL_KEY] as Pool;

export async function getHost(opts: ConnectOpts): Promise<RemoteHost> {
  const key = makeKey(opts);
  let host = pool.get(key);
  if (host && host.closed) {
    pool.delete(key);
    host = undefined;
  }
  if (!host) {
    host = new RemoteHost(opts);
    pool.set(key, host);
  }
  await host.connect();
  return host;
}

export function disconnectHost(opts: ConnectOpts): void {
  const key = makeKey(opts);
  const host = pool.get(key);
  if (!host) return;
  host.close();
  pool.delete(key);
}

export function listConnectedHosts(): { key: string; opts: ConnectOpts }[] {
  return Array.from(pool.values())
    .filter((h) => !h.closed)
    .map((h) => ({ key: h.key, opts: h.opts }));
}
