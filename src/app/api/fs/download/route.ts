import { spawn } from 'node:child_process';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { parseCwd } from '@/lib/cwd';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/fs/download?cwd=<workspace>&path=<abs>
 *
 * Streams a path back to the browser as an attachment. Symmetric with
 * /api/fs/upload and workspace-agnostic:
 *
 *   - A regular file streams verbatim (from disk locally, over SFTP for SSH).
 *   - A directory is packed into a gzipped tar **on the fly** and streamed —
 *     `tar` runs locally for local workspaces and on the remote host for SSH
 *     workspaces, with its stdout piped straight to the response. Nothing is
 *     buffered in server memory and there is no size cap, so a folder with a
 *     ton of stuff in it downloads as one `<name>.tar.gz`.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd');
  const target = url.searchParams.get('path');
  if (!cwd || !target) {
    return Response.json({ error: 'cwd and path are required' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseCwd(cwd);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'invalid cwd' },
      { status: 400 },
    );
  }

  if (parsed.kind === 'local') {
    return handleLocal(target);
  }
  return handleSsh(cwd, parsed, target);
}

// ───────────────────────────── local ──────────────────────────────────────

async function handleLocal(target: string): Promise<Response> {
  let abs: string;
  let stat: fs.Stats;
  try {
    abs = path.resolve(target);
    stat = await fsp.stat(abs);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'read failed', path: target },
      { status: 400 },
    );
  }

  if (stat.isDirectory()) {
    // tar -czf - -C <parent> -- <base>  →  stream stdout as the archive.
    const parent = path.dirname(abs);
    const base = path.basename(abs);
    const child = spawn('tar', ['-czf', '-', '-C', parent, '--', base], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const body = nodeToWeb(child.stdout, () => child.kill('SIGTERM'));
    // If `tar` can't even be spawned (not on PATH), surface it — but the
    // response has not been returned yet only for the synchronous throw; an
    // async spawn error just ends the stream. We attach a handler so it can't
    // crash the process.
    child.on('error', () => child.stdout.destroy());
    return new Response(body, {
      status: 200,
      headers: archiveHeaders(`${base}.tar.gz`),
    });
  }

  if (!stat.isFile()) {
    return Response.json({ error: 'not a file or directory', path: abs }, { status: 400 });
  }

  const nodeStream = fs.createReadStream(abs);
  const body = nodeToWeb(nodeStream, () => nodeStream.destroy());
  return new Response(body, {
    status: 200,
    headers: fileHeaders(path.basename(abs), stat.size),
  });
}

// ────────────────────────────── ssh ───────────────────────────────────────

async function handleSsh(
  cwd: string,
  parsed: Extract<ReturnType<typeof parseCwd>, { kind: 'ssh' }>,
  target: string,
): Promise<Response> {
  const ws = getWorkspace(cwd);
  if (!ws) {
    return Response.json({ error: 'workspace not found' }, { status: 404 });
  }
  const stored = getStoredSshPassword(cwd);
  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws.sshIdentityPath,
    useAgent: ws.sshUseAgent,
    expectedHostFingerprint: ws.sshKnownHostFp,
    password: stored ?? undefined,
  };

  let host;
  try {
    host = await getHost(opts);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'connect failed' },
      { status: 502 },
    );
  }

  let abs = target;
  if (abs === '~' || abs.startsWith('~')) {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';
    abs = abs === '~' ? home : home + abs.slice(1);
  }
  if (!abs.startsWith('/')) abs = '/' + abs;

  const sftp = await host.sftp();
  const stat = await new Promise<{ size: number; mode: number } | { __error: string }>(
    (resolve) => {
      sftp.stat(abs, (err, st) => {
        if (err) resolve({ __error: err.message });
        else resolve({ size: st.size, mode: st.mode });
      });
    },
  );
  if ('__error' in stat) {
    return Response.json({ error: stat.__error, path: abs }, { status: 400 });
  }

  const fileType = stat.mode & 0o170000;

  if (fileType === 0o040000) {
    // Remote directory → run tar on the host, stream its stdout back.
    const parent = posixDirname(abs);
    const base = posixBasename(abs);
    const cmd = `tar -czf - -C ${shq(parent)} -- ${shq(base)}`;
    const stream = await host.execRaw(cmd);
    const body = nodeToWeb(stream as unknown as Readable, () => stream.destroy());
    return new Response(body, {
      status: 200,
      headers: archiveHeaders(`${base}.tar.gz`),
    });
  }

  if (fileType !== 0o100000) {
    return Response.json({ error: 'not a regular file', path: abs }, { status: 400 });
  }

  // Regular remote file → stream over SFTP.
  const remoteStream = sftp.createReadStream(abs);
  const body = nodeToWeb(
    remoteStream as unknown as Readable,
    () => (remoteStream as unknown as Readable).destroy(),
  );
  return new Response(body, {
    status: 200,
    headers: fileHeaders(posixBasename(abs), stat.size),
  });
}

// ──────────────────────────── helpers ─────────────────────────────────────

/**
 * Adapt a Node Readable to a web ReadableStream. We don't use
 * `Readable.toWeb` directly because we also want `cancel()` (the browser
 * aborting the download) to tear down the underlying source — a half-read
 * `tar` child process or SSH channel must not linger.
 */
function nodeToWeb(
  node: NodeJS.ReadableStream,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      node.on('end', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      node.on('error', (err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
    },
    cancel() {
      try {
        onCancel();
      } catch {
        /* best effort */
      }
    },
  });
}

function fileHeaders(name: string, size: number): HeadersInit {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': disposition(name),
    'Cache-Control': 'no-store',
  };
}

/** Archives are streamed, so the length is unknown up front — omit it. */
function archiveHeaders(name: string): HeadersInit {
  return {
    'Content-Type': 'application/gzip',
    'Content-Disposition': disposition(name),
    'Cache-Control': 'no-store',
  };
}

/**
 * Attachment disposition with a filename that survives non-ASCII: a plain
 * `filename` fallback for old agents plus the RFC 5987 `filename*` form
 * every modern browser prefers.
 */
function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return (
    `attachment; filename="${fallback}"; ` +
    `filename*=UTF-8''${encodeURIComponent(name)}`
  );
}

/** Single-quote a string for safe interpolation into a remote shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function posixDirname(p: string): string {
  const norm = p.replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  if (i <= 0) return '/';
  return norm.slice(0, i);
}

function posixBasename(p: string): string {
  const norm = p.replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}
