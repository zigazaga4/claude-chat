/**
 * OS-aware command + path layer for remote SSH work.
 *
 * The remote tools (Bash/Read/Write/Edit/Glob/Grep/LS), the file browser, the
 * folder-download tar, and the interactive terminal all used to assume the
 * remote host is POSIX (bash + GNU coreutils, `/`-rooted paths). That breaks
 * against a native Windows OpenSSH server whose shell is cmd.exe/PowerShell.
 *
 * This module is the ONE place that knows how to speak to each platform, so the
 * callers stay dumb: they resolve `RemotePlatform` once (via
 * `RemoteHost.platform()`) and ask here for the right command string / path.
 *
 * Windows strategy: rather than depend on whether the remote default shell is
 * cmd.exe or PowerShell, every generated Windows command is a PowerShell script
 * invoked as `powershell -NoProfile -NonInteractive -EncodedCommand <base64>`.
 * `-EncodedCommand` takes Base64-of-UTF16LE, so the script survives the
 * SSH → default-shell → powershell hops with zero quoting/escaping hazards.
 *
 * "posix" also covers WSL and Git-Bash-as-default-shell on a Windows box: if
 * `uname` answers, a POSIX shell + coreutils are present and the bash path is
 * exactly right, so we deliberately treat those as posix.
 */

import { Buffer } from 'node:buffer';
import path from 'node:path';

export type RemotePlatform = 'posix' | 'windows';

// ───────────────────────────── quoting ────────────────────────────────────

/** POSIX single-quote: wrap in '' and escape embedded quotes as '\''. */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string literal: embedded ' is doubled to ''. */
export function psLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Wrap a PowerShell script as a full command line that runs the same whether
 * the remote default shell is cmd.exe or PowerShell. Base64-of-UTF16LE is what
 * `-EncodedCommand` expects.
 */
export function psEncode(script: string): string {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
}

// ───────────────────────────── paths ──────────────────────────────────────

/** Is `p` an absolute path on the given platform? */
export function isRemoteAbsolute(p: string, platform: RemotePlatform): boolean {
  if (platform === 'windows') {
    return (
      /^[A-Za-z]:[\\/]/.test(p) || // C:\ or C:/
      /^\/[A-Za-z]:[\\/]/.test(p) || // /C:/  (SFTP form)
      p.startsWith('\\\\') || // UNC
      p.startsWith('//') || // UNC (fwd)
      p.startsWith('/') // SFTP root
    );
  }
  return p.startsWith('/');
}

/**
 * Resolve a possibly-relative remote path against the workspace base, returning
 * the **SFTP form** used for ssh2 file ops. Windows OpenSSH's SFTP subsystem
 * accepts forward slashes and the `/C:/Users/...` drive form, so we normalise
 * to that: backslashes → `/`, and a bare-drive `C:/x` gains a leading `/`.
 */
export function resolveRemotePath(
  p: string,
  base: string,
  platform: RemotePlatform,
): string {
  // Belt-and-braces, independent of `platform`: a drive-rooted path (`C:\x`,
  // `C:/x`, or the SFTP `/C:/x` form) is ALWAYS absolute and must never be
  // joined onto the base. Without this, a Windows path resolved while platform
  // was briefly misdetected as posix became `/base/C:\x` — the exact "path
  // reappended" corruption. Normalise backslashes and return the SFTP form.
  const fwd = p.replace(/\\/g, '/');
  if (/^\/?[A-Za-z]:\//.test(fwd)) {
    return /^[A-Za-z]:/.test(fwd) ? `/${fwd}` : fwd;
  }

  if (platform === 'windows') {
    if (isRemoteAbsolute(fwd, platform)) return fwd; // UNC or /-rooted SFTP path
    return path.posix.join(base, fwd);
  }
  if (p.startsWith('/')) return p;
  return path.posix.join(base, p);
}

/**
 * Convert an SFTP-form path (`/C:/Users/x`) to the form a Windows shell wants
 * (`C:/Users/x` — PowerShell accepts forward slashes fine). No-op if already
 * drive-rooted.
 */
export function toWinPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1');
}

/** Backslash form (`C:\Users\x`) for cmd.exe, which is fussier than PowerShell. */
export function toWinBackslashPath(p: string): string {
  return toWinPath(p).replace(/\//g, '\\');
}

// ─────────────────────── glob → regex translation ─────────────────────────

/**
 * Translate a shell glob (`**`, `*`, `?`) into an anchored .NET/JS regex over a
 * forward-slash relative path. `**` crosses directory separators, `*`/`?` do
 * not. Used to give Windows glob the same semantics bash's globstar gives.
 */
export function globToRegex(glob: string): string {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // **/  → optional any-depth prefix
        } else {
          re += '.*'; // **   → anything, crossing separators
        }
      } else {
        re += '[^/]*'; // *    → anything but a separator
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return `^${re}$`;
}

// ─────────────────────────── command builders ─────────────────────────────
// Each returns a single command string ready for `RemoteHost.exec()`.

/** Bash tool: cd into the workspace, then run the model's command. */
export function buildBashCommand(
  base: string,
  command: string,
  platform: RemotePlatform,
): string {
  if (platform === 'windows') {
    // Run the model's (PowerShell) command in the workspace dir; propagate the
    // last native exit code so the tool's ok/err classification stays honest.
    const script =
      `Set-Location -LiteralPath ${psLit(toWinPath(base))} -ErrorAction SilentlyContinue\n` +
      `${command}\n` +
      `exit $LASTEXITCODE`;
    return psEncode(script);
  }
  return `cd ${posixQuote(base)} 2>/dev/null; ${command}`;
}

/** Glob: emit matches as paths RELATIVE to `root`, one per line, `/`-separated. */
export function buildGlobCommand(
  root: string,
  pattern: string,
  platform: RemotePlatform,
): string {
  if (platform === 'windows') {
    const winRoot = toWinPath(root);
    const script = [
      `$root = ${psLit(winRoot)}`,
      `$rx = ${psLit(globToRegex(pattern))}`,
      `Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue |`,
      `  ForEach-Object {`,
      `    $rel = ($_.FullName.Substring($root.Length).TrimStart('\\','/')) -replace '\\\\','/'`,
      `    if ($rel -match $rx) { $rel }`,
      `  }`,
    ].join('\n');
    return psEncode(script);
  }
  return (
    `bash -c 'shopt -s globstar nullglob dotglob; cd ${posixQuote(root)} && ` +
    `for f in ${pattern}; do printf "%s\\n" "$f"; done'`
  );
}

export type GrepSpec = {
  root: string;
  pattern: string;
  glob?: string;
  caseInsensitive?: boolean;
  context?: number;
  max: number;
};

/**
 * Grep for Windows via `Select-String`. (POSIX grep/ripgrep stays in the tool,
 * since it probes for `rg` first.) Output mirrors `path:line:text`.
 */
export function buildWindowsGrepCommand(spec: GrepSpec): string {
  const winRoot = toWinPath(spec.root);
  const gci =
    `Get-ChildItem -LiteralPath ${psLit(winRoot)} -Recurse -File -Force -ErrorAction SilentlyContinue` +
    (spec.glob ? ` -Filter ${psLit(spec.glob)}` : '');
  // Select-String is case-INsensitive by default; GNU grep is case-sensitive,
  // so add -CaseSensitive unless the caller asked for insensitivity.
  const ss =
    `Select-String -Pattern ${psLit(spec.pattern)}` +
    (spec.caseInsensitive ? '' : ' -CaseSensitive') +
    (spec.context ? ` -Context ${spec.context},${spec.context}` : '');
  const emit = spec.context
    ? // With context, print the pre-lines, the match, then the post-lines.
      `ForEach-Object {` +
      ` $p = ($_.Path -replace '\\\\','/');` +
      ` $_.Context.PreContext | ForEach-Object { "$p- $_" };` +
      ` "$p:$($_.LineNumber):$($_.Line)";` +
      ` $_.Context.PostContext | ForEach-Object { "$p- $_" } }`
    : `ForEach-Object { "$($_.Path -replace '\\\\','/'):$($_.LineNumber):$($_.Line)" }`;
  const script = `${gci} | ${ss} | Select-Object -First ${spec.max} | ${emit}`;
  return psEncode(script);
}

/** LS: long listing including hidden entries. */
export function buildLsCommand(abs: string, platform: RemotePlatform): string {
  if (platform === 'windows') {
    const script =
      `Get-ChildItem -LiteralPath ${psLit(toWinPath(abs))} -Force -ErrorAction Stop |\n` +
      `  ForEach-Object {\n` +
      `    '{0} {1,12} {2:yyyy-MM-dd HH:mm} {3}' -f ` +
      `$(if ($_.PSIsContainer) {'d'} else {'-'}), $_.Length, $_.LastWriteTime, $_.Name\n` +
      `  }`;
    return psEncode(script);
  }
  return `ls -la --time-style=long-iso ${posixQuote(abs)}`;
}

/** Recursive mkdir (mkdir -p semantics), tolerating existing dirs. */
export function buildMkdirpCommand(
  dir: string,
  platform: RemotePlatform,
): string {
  if (platform === 'windows') {
    return psEncode(
      `New-Item -ItemType Directory -Force -Path ${psLit(toWinPath(dir))} | Out-Null`,
    );
  }
  return `mkdir -p ${posixQuote(dir)}`;
}

/**
 * Preamble written into an interactive shell channel to cd into the workspace.
 * The interactive shell is the remote's *default* shell, so on Windows we emit
 * a cmd.exe form (the out-of-the-box OpenSSH default); a host reconfigured to
 * PowerShell will show one harmless error line instead of auto-cd'ing.
 */
export function buildShellCdPreamble(
  cwd: string,
  platform: RemotePlatform,
): string {
  if (platform === 'windows') {
    return `cd /d "${toWinBackslashPath(cwd)}" 2>nul & cls\r\n`;
  }
  return `cd ${posixQuote(cwd)} 2>/dev/null && clear\n`;
}
