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
import { parseCwd } from '@/lib/cwd';
import { buildShellCdPreamble, type RemotePlatform } from './remoteShell';
import { getStoredSshPassword, getWorkspace } from './workspaces';

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

/**
 * Build ConnectOpts for an `ssh://…` workspace cwd from its stored metadata —
 * the one definition of "how this app reaches that host": identity file,
 * agent flag, TOFU pin, remembered password. The remote tools, the MCP
 * connector's ssh-stdio transport, and anything else that wants a pooled
 * host all resolve through here so they can never disagree.
 *
 * Returns null for local (non-ssh://) cwds.
 */
export function connectOptsForWorkspace(
  workspaceCwd: string,
): ConnectOpts | null {
  const parsed = parseCwd(workspaceCwd);
  if (parsed.kind !== 'ssh') return null;
  const ws = getWorkspace(workspaceCwd);
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws?.sshIdentityPath ?? null,
    useAgent: ws?.sshUseAgent ?? false,
    expectedHostFingerprint: ws?.sshKnownHostFp ?? null,
    password: getStoredSshPassword(workspaceCwd) ?? undefined,
  };
}

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
};

const READY_TIMEOUT_MS = 15_000;
const KEEPALIVE_MS = 20_000;
/**
 * How many missed keepalives before ssh2 declares the link dead. Kept high so a
 * brief Tailscale/Wi-Fi hiccup doesn't tear down an otherwise-fine connection
 * (the terminal's `ssh` is similarly patient). Real death is caught cheaply by
 * the liveness probe on checkout (see `ping` / `getHost`).
 */
const KEEPALIVE_COUNT_MAX = 6;
/** Bound for the on-checkout liveness probe — a dead socket fails fast. */
const PING_TIMEOUT_MS = 4_000;
/**
 * If a pooled connection proved alive (connected, pinged, or ran a command)
 * within this window, skip the checkout probe — a socket used seconds ago is
 * almost certainly still up, so hot tool sequences stay snappy.
 */
const LIVENESS_FRESH_MS = 3_000;

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
  /** Epoch ms of the last proof the link was alive (connect/ping/exec). */
  lastOkAt = 0;
  closed = false;
  /** Memoised remote OS family — probed once, stable for the host's lifetime. */
  private platformCache: RemotePlatform | null = null;

  constructor(opts: ConnectOpts) {
    this.opts = opts;
    this.key = makeKey(opts);
  }

  async connect(): Promise<void> {
    // If a previous connection died, the `ready` promise is stale — drop it so
    // we dial again instead of handing back a dead client.
    if (this.closed || !this.client) this.ready = null;
    if (this.ready) return this.ready;
    this.closed = false;
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
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        // Capture the host fingerprint for display, but always trust — exactly
        // like the terminal once the host is in known_hosts. Enforcing a pin
        // here caused intermittent failures when a later handshake negotiated a
        // different host-key type than the one first captured, so we don't.
        hostVerifier: (key: Buffer | string) => {
          const buf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
          this.hostFingerprint = sha256Fingerprint(buf);
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
        this.lastOkAt = Date.now();
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

  /**
   * The live ssh2 client, or a clean error if the link died.
   *
   * `connect()` resolving does NOT guarantee `this.client` is still set: the
   * 'close' handler nulls it, and ssh2 can emit 'ready' and 'close' back to
   * back on a flaky link (Tailscale/Wi-Fi drop, keepalive timeout), which lands
   * the close between the await resolving and the deref. Every channel opener
   * used to write `this.client!` and so crashed with an opaque
   * "Cannot read properties of null (reading 'sftp')" TypeError instead of a
   * message anyone could act on. Callers get a real Error now, and `getHost`
   * redials on the next attempt.
   */
  private activeClient(): Client {
    const client = this.client;
    if (!client || this.closed) {
      throw new Error(
        `SSH connection to ${this.opts.user}@${this.opts.host}:${this.opts.port} ` +
          'dropped. Reconnect and try again.',
      );
    }
    return client;
  }

  /**
   * Cheap liveness probe: run a trivial command with a hard timeout against the
   * EXISTING client (never reconnects). A socket that was silently dropped
   * (Tailscale/idle death ssh2 hasn't noticed yet) fails fast here, letting the
   * pool tear down and redial instead of handing back a dead channel — which is
   * the difference between "sometimes connects, sometimes hangs" and "always
   * connects, like the terminal".
   */
  async ping(): Promise<boolean> {
    const client = this.client;
    if (!client || this.closed) return false;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (ok) this.lastOkAt = Date.now();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), PING_TIMEOUT_MS);
      try {
        client.exec('true', (err, stream) => {
          if (err) {
            finish(false);
            return;
          }
          stream.on('error', () => finish(false));
          stream.on('close', () => finish(true));
          stream.resume();
          stream.stderr.resume();
        });
      } catch {
        finish(false);
      }
    });
  }

  /**
   * `sftp.realpath('.')` — the SFTP default dir. `/home/user` on POSIX,
   * `/C:/Users/user` on Windows OpenSSH. Resolved by the SFTP subsystem, so it
   * does NOT depend on any shell builtin and survives a flaky interactive
   * shell. Returns null on error.
   */
  private async sftpRealpathDot(): Promise<string | null> {
    try {
      const sftp = await this.sftp();
      return await new Promise<string | null>((resolve) => {
        sftp.realpath('.', (err, resolved) =>
          resolve(err || !resolved ? null : resolved),
        );
      });
    } catch {
      return null;
    }
  }

  /**
   * Remote OS family, memoised.
   *
   * PRIMARY signal is `sftp.realpath('.')`: a drive-rooted result (`/C:/...`)
   * is unambiguously Windows OpenSSH, anything else absolute is POSIX. This is
   * resolved by the SFTP subsystem — not the interactive shell — so it can't be
   * derailed by a `uname` that transiently fails on a lossy link, which is the
   * exact failure that mis-tagged a Windows host as POSIX and mangled its
   * paths for the whole session.
   *
   * FALLBACK (SFTP unavailable) is the `uname` probe: exit 0 with output means
   * a POSIX shell is present — Linux, macOS, *BSD, and also a Windows box whose
   * SSH shell is WSL/Git-Bash (where the bash tooling genuinely works); no
   * `uname` means a native Windows shell.
   *
   * Only a POSITIVE detection is cached. An inconclusive probe (both signals
   * failed) returns 'posix' WITHOUT caching, so a later call retries rather
   * than freezing a guess for the session.
   */
  async platform(): Promise<RemotePlatform> {
    if (this.platformCache) return this.platformCache;

    const real = await this.sftpRealpathDot();
    if (real) {
      // `/C:/Users/...` or `C:/...` → Windows; a plain POSIX root → posix.
      const detected: RemotePlatform = /^\/?[A-Za-z]:[\\/]/.test(real)
        ? 'windows'
        : 'posix';
      this.platformCache = detected;
      return detected;
    }

    try {
      const r = await this.exec('uname');
      const detected: RemotePlatform =
        r.code === 0 && r.stdout.trim() ? 'posix' : 'windows';
      this.platformCache = detected;
      return detected;
    } catch {
      // Neither signal answered — the OS is genuinely unknown right now. Assume
      // posix but do NOT cache, so the next call re-probes instead of locking
      // in a guess.
      return 'posix';
    }
  }

  /**
   * The remote home directory, OS-agnostically. Uses the same SFTP realpath
   * probe as platform detection (`/home/user` on POSIX, `/C:/Users/user` on
   * Windows), falling back to a POSIX `$HOME` shell probe, then `/`.
   */
  async homeDir(): Promise<string> {
    const real = await this.sftpRealpathDot();
    if (real) return real;
    try {
      const r = await this.exec('printf %s "$HOME"');
      if (r.stdout.trim()) return r.stdout.trim();
    } catch {
      /* ignore */
    }
    return '/';
  }

  async exec(command: string, opts?: { stdin?: string }): Promise<ExecResult> {
    await this.connect();
    const client = this.activeClient();
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
          this.lastOkAt = Date.now();
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
          this.activeClient().exec(command, (err, stream) => {
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

  /**
   * Open an exec channel and hand back the raw ssh2 stream **without** any
   * string coercion, so binary payloads (e.g. a `tar` archive on stdout)
   * survive intact. The caller owns the stream and must consume it. stderr
   * is drained here so a chatty command can't stall on a full window.
   */
  async execRaw(command: string): Promise<ClientChannel> {
    await this.connect();
    const client = this.activeClient();
    return new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        stream.stderr.resume();
        resolve(stream);
      });
    });
  }

  async sftp(): Promise<SFTPWrapper> {
    await this.connect();
    if (this.sftpHandle) return this.sftpHandle;
    if (this.sftpPromise) return this.sftpPromise;
    const client = this.activeClient();
    this.sftpPromise = new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
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
    // Resolve the OS up front so the cd preamble matches the remote shell.
    const platform = opts.cwd ? await this.platform() : 'posix';
    const client = this.activeClient();
    return new Promise((resolve, reject) => {
      client.shell(
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
          // user. We send a single command followed by a clear so the user
          // doesn't see the cd preamble in their scrollback. The exact syntax
          // depends on the remote OS (POSIX sh vs Windows cmd).
          if (opts.cwd) {
            stream.write(buildShellCdPreamble(opts.cwd, platform));
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
  const reused = !!host;
  if (!host) {
    host = new RemoteHost(opts);
    pool.set(key, host);
  }
  await host.connect();

  // A pooled connection can be silently dead (socket dropped by Tailscale/idle
  // before ssh2's keepalive noticed). Verify it's actually alive before handing
  // it out; if not, throw it away and dial a fresh one. Skip the probe when the
  // link proved alive moments ago (hot tool sequences) or was just established.
  const stale = Date.now() - host.lastOkAt > LIVENESS_FRESH_MS;
  if (reused && stale && !(await host.ping())) {
    host.close();
    pool.delete(key);
    host = new RemoteHost(opts);
    pool.set(key, host);
    await host.connect();
  }
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
