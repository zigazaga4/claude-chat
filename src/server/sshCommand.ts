/**
 * Resolve a literal `ssh` shell command (e.g. `ssh leonard`,
 * `ssh -p 2222 ubuntu@1.2.3.4 -i ~/.ssh/key`) into the concrete connection
 * parameters the rest of the app already speaks: { host, port, user,
 * identityPath }. This is what powers the simplified "add SSH" flow — the user
 * types the same command they'd type in a terminal and we figure out the rest,
 * including expanding a `~/.ssh/config` Host alias (HostName/User/Port/
 * IdentityFile), exactly like the real `ssh` client does.
 *
 * Nothing here touches the live connection machinery (ssh2 / RemoteHost) or the
 * remote tools — it only produces the same { host, port, user, identityPath }
 * tuple the existing test/connect/browse endpoints consume.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ResolvedSshTarget = {
  /** Real hostname/IP to dial (after ~/.ssh/config HostName resolution). */
  host: string;
  port: number;
  user: string;
  /** Expanded absolute identity file path, or null to fall back to discovery. */
  identityPath: string | null;
  /** The raw destination token as typed (alias before resolution). */
  alias: string;
  /** Human-readable one-line summary of what we resolved, for the UI. */
  label: string;
};

export type ResolveResult =
  | ({ ok: true } & ResolvedSshTarget)
  | { ok: false; error: string };

/** ssh single-letter options that consume the following token as their value. */
const ARG_OPTS = new Set([
  'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p',
  'Q', 'R', 'S', 'W', 'w',
]);

/**
 * Split a command line into tokens, honoring single/double quotes and
 * backslash escaping so paths with spaces survive. Good enough for an ssh
 * invocation typed by a human — we are not implementing a full POSIX shell.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        cur += input[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

type CliParse = {
  destination?: string;
  user?: string;
  port?: number;
  identity?: string;
  hostName?: string;
  error?: string;
};

/** Parse the ssh command tokens into the bits we care about. */
function parseCli(tokens: string[]): CliParse {
  const out: CliParse = {};
  let i = 0;
  // Drop a leading `ssh` (the user may type the whole command or just the
  // destination). Anything else leading is treated as a destination/option.
  if (tokens[i] && tokens[i].toLowerCase() === 'ssh') i++;

  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') continue;
    if (tok.startsWith('-') && tok.length > 1) {
      const optChar = tok[1];
      const inline = tok.slice(2);
      if (ARG_OPTS.has(optChar)) {
        const value = inline.length > 0 ? inline : tokens[++i];
        if (value == null) {
          out.error = `Option -${optChar} expects a value`;
          return out;
        }
        applyOpt(out, optChar, value);
      }
      // Non-arg flags (e.g. -v, -A, -T, -4) carry no value we need — ignore.
      continue;
    }
    // First bare token is the destination; later bare tokens are the remote
    // command (ignored). Keep scanning so options written *after* the
    // destination (e.g. `ssh myhost -p 2222`) are still honored — the real
    // ssh client relies on glibc getopt permutation, which reorders options
    // ahead of the destination regardless of where they were typed.
    if (out.destination === undefined) out.destination = tok;
  }
  return out;
}

function applyOpt(out: CliParse, optChar: string, value: string): void {
  switch (optChar) {
    case 'p': {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) out.port = n;
      break;
    }
    case 'i':
      out.identity = value;
      break;
    case 'l':
      out.user = value;
      break;
    case 'o':
      applyDashO(out, value);
      break;
    default:
      break; // other arg-taking options consume their value but we ignore it
  }
}

/** Handle `-o Key=Value` / `-o "Key Value"` for the keys we understand. */
function applyDashO(out: CliParse, value: string): void {
  const m = value.match(/^\s*([A-Za-z]+)\s*[=\s]\s*(.+?)\s*$/);
  if (!m) return;
  const key = m[1].toLowerCase();
  const val = m[2];
  if (key === 'hostname') out.hostName = val;
  else if (key === 'user') out.user = val;
  else if (key === 'port') {
    const n = parseInt(val, 10);
    if (Number.isFinite(n) && n > 0) out.port = n;
  } else if (key === 'identityfile') out.identity = val;
}

/** Split a destination token into { user?, host, port? }, incl. ssh:// URIs. */
function splitDestination(dest: string): { user?: string; host: string; port?: number } {
  let s = dest;
  let port: number | undefined;
  if (s.startsWith('ssh://')) {
    s = s.slice('ssh://'.length);
    const slash = s.indexOf('/');
    if (slash >= 0) s = s.slice(0, slash); // drop any /path
  }
  let user: string | undefined;
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    user = s.slice(0, at);
    s = s.slice(at + 1);
  }
  // host:port (only meaningful for the URI form; a bare host rarely has one)
  const colon = s.lastIndexOf(':');
  if (colon >= 0) {
    const maybePort = parseInt(s.slice(colon + 1), 10);
    if (Number.isFinite(maybePort) && maybePort > 0 && /^\d+$/.test(s.slice(colon + 1))) {
      port = maybePort;
      s = s.slice(0, colon);
    }
  }
  return { user, host: s, port };
}

// ---- ~/.ssh/config resolution -------------------------------------------

type HostConfig = {
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

type ConfigBlock = { patterns: string[]; entries: [string, string][] };

function parseConfigBlocks(text: string): ConfigBlock[] {
  const blocks: ConfigBlock[] = [];
  let current: ConfigBlock | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const sp = line.search(/\s/);
    let keyword: string;
    let rest: string;
    if (eq >= 0 && (sp < 0 || eq < sp)) {
      keyword = line.slice(0, eq).trim();
      rest = line.slice(eq + 1).trim();
    } else if (sp >= 0) {
      keyword = line.slice(0, sp).trim();
      rest = line.slice(sp + 1).trim();
    } else {
      keyword = line;
      rest = '';
    }
    const kw = keyword.toLowerCase();
    if (kw === 'host') {
      if (current) blocks.push(current);
      current = { patterns: rest.split(/\s+/).filter(Boolean), entries: [] };
    } else if (kw === 'match') {
      // We don't evaluate Match blocks; close the current Host block so its
      // directives don't leak into a Match-gated section.
      if (current) blocks.push(current);
      current = null;
    } else if (current) {
      const val = rest.replace(/^"(.*)"$/, '$1');
      current.entries.push([kw, val]);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * True if an ssh `Host` pattern list matches the alias. A matching negated
 * pattern (`!pattern`) excludes the block outright; otherwise any positive
 * match wins — mirroring ssh's own semantics.
 */
function hostMatches(patterns: string[], host: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (simpleGlob(p.slice(1), host)) return false;
    } else if (simpleGlob(p, host)) {
      matched = true;
    }
  }
  return matched;
}

function simpleGlob(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  const re = '^' +
    pattern
      .split('')
      .map((ch) => {
        if (ch === '*') return '.*';
        if (ch === '?') return '.';
        if (/[.+^${}()|[\]\\]/.test(ch)) return '\\' + ch;
        return ch;
      })
      .join('') +
    '$';
  return new RegExp(re).test(host);
}

/**
 * Resolve a host alias through ~/.ssh/config the way ssh does: walk blocks top
 * to bottom and take the FIRST value seen for each keyword across all matching
 * Host blocks.
 */
function resolveFromConfig(alias: string, home: string): HostConfig {
  const cfg: HostConfig = {};
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8');
  } catch {
    return cfg;
  }
  for (const block of parseConfigBlocks(text)) {
    if (!hostMatches(block.patterns, alias)) continue;
    for (const [kw, val] of block.entries) {
      if (kw === 'hostname' && cfg.hostName === undefined) cfg.hostName = val;
      else if (kw === 'user' && cfg.user === undefined) cfg.user = val;
      else if (kw === 'port' && cfg.port === undefined) {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n > 0) cfg.port = n;
      } else if (kw === 'identityfile' && cfg.identityFile === undefined) {
        cfg.identityFile = val;
      }
    }
  }
  return cfg;
}

function expandPath(p: string, home: string): string {
  let out = p;
  if (out.startsWith('~/')) out = path.join(home, out.slice(2));
  else if (out === '~') out = home;
  out = out.replace(/\$\{?HOME\}?/g, home);
  return out;
}

/**
 * Parse + resolve a literal ssh command into concrete connection parameters.
 * Command-line flags win over ~/.ssh/config; config wins over defaults.
 */
export function resolveSshCommand(command: string): ResolveResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, error: 'Enter an ssh command, e.g. `ssh leonard`.' };

  const tokens = tokenizeCommand(trimmed);
  const cli = parseCli(tokens);
  if (cli.error) return { ok: false, error: cli.error };
  if (!cli.destination) {
    return {
      ok: false,
      error: 'No host found in the command. Try `ssh user@host` or an `ssh` config alias like `ssh leonard`.',
    };
  }

  const home = os.homedir();
  const dest = splitDestination(cli.destination);
  const alias = dest.host;
  const cfg = resolveFromConfig(alias, home);

  // Precedence: explicit CLI > ~/.ssh/config > sensible default.
  const host = cli.hostName || cfg.hostName || dest.host;
  const port = cli.port ?? dest.port ?? cfg.port ?? 22;
  const user =
    cli.user || dest.user || cfg.user || os.userInfo().username || 'root';
  const rawIdentity = cli.identity ?? cfg.identityFile ?? null;
  const identityPath = rawIdentity ? expandPath(rawIdentity, home) : null;

  if (!host) {
    return { ok: false, error: 'Could not determine a hostname to connect to.' };
  }

  const portLabel = port === 22 ? '' : `:${port}`;
  const keyLabel = identityPath ? ` · key ${rawIdentity}` : '';
  const aliasLabel = host !== alias ? ` (alias ${alias})` : '';
  const label = `${user}@${host}${portLabel}${aliasLabel}${keyLabel}`;

  return { ok: true, host, port, user, identityPath, alias, label };
}
