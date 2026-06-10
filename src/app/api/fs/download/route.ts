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
 * Streams a file back to the browser as an attachment. Symmetric with
 * /api/fs/upload: works for both local workspaces (read from disk) and SSH
 * workspaces (streamed from the remote host over SFTP). No size cap — the
 * body is streamed chunk by chunk, never buffered in memory.
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
    try {
      const abs = path.resolve(target);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) {
        return Response.json({ error: 'not a file', path: abs }, { status: 400 });
      }
      const nodeStream = fs.createReadStream(abs);
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      return new Response(body, {
        status: 200,
        headers: downloadHeaders(path.basename(abs), stat.size),
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'read failed', path: target },
        { status: 400 },
      );
    }
  }

  // ─── SSH ────────────────────────────────────────────────────────────────
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
  if ((stat.mode & 0o170000) !== 0o100000) {
    return Response.json({ error: 'not a regular file', path: abs }, { status: 400 });
  }

  // sftp.createReadStream is a Node Readable — same shape the local branch
  // uses, so the streaming response path is identical from here on.
  const remoteStream = sftp.createReadStream(abs);
  const body = Readable.toWeb(
    remoteStream as unknown as Readable,
  ) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: downloadHeaders(path.posix.basename(abs), stat.size),
  });
}

/**
 * Attachment headers with a filename that survives non-ASCII characters:
 * a plain `filename` fallback for old agents plus the RFC 5987 `filename*`
 * form every modern browser prefers.
 */
function downloadHeaders(name: string, size: number): HeadersInit {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition':
      `attachment; filename="${fallback}"; ` +
      `filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  };
}
