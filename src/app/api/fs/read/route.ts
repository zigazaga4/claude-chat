import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { parseCwd } from '@/lib/cwd';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB hard limit for the IDE viewer

type Result = {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
};

/**
 * Cheap heuristic: if the first few KB contains a NUL byte, treat it as
 * binary and refuse to render. Same heuristic git itself uses.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * GET /api/fs/read?cwd=<workspace>&path=<abs>
 *
 * Reads a regular file under the workspace (local or SSH) and returns it
 * as UTF-8 text for the IDE viewer. Hard 2 MB cap; binary files surface
 * as `binary: true` with empty content so the UI can show a placeholder.
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
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return Response.json({ error: 'not a file', path: abs }, { status: 400 });
      }
      const truncated = stat.size > MAX_BYTES;
      const handle = await fs.open(abs, 'r');
      try {
        const len = Math.min(stat.size, MAX_BYTES);
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, 0);
        const binary = looksBinary(buf);
        const result: Result = {
          path: abs,
          size: stat.size,
          truncated,
          binary,
          content: binary ? '' : buf.toString('utf8'),
        };
        return Response.json(result);
      } finally {
        await handle.close();
      }
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

  const truncated = stat.size > MAX_BYTES;
  const cap = Math.min(stat.size, MAX_BYTES);

  const buf = await new Promise<Buffer | { __error: string }>((resolve) => {
    sftp.open(abs, 'r', (err, handle) => {
      if (err || !handle) {
        resolve({ __error: err?.message ?? 'open failed' });
        return;
      }
      const out = Buffer.alloc(cap);
      let total = 0;
      const readNext = () => {
        if (total >= cap) {
          sftp.close(handle, () => resolve(out));
          return;
        }
        sftp.read(handle, out, total, cap - total, total, (rerr, bytesRead) => {
          if (rerr) {
            sftp.close(handle, () => resolve({ __error: rerr.message }));
            return;
          }
          if (!bytesRead) {
            sftp.close(handle, () => resolve(out.subarray(0, total)));
            return;
          }
          total += bytesRead;
          readNext();
        });
      };
      readNext();
    });
  });

  if (!Buffer.isBuffer(buf) && '__error' in buf) {
    return Response.json({ error: buf.__error, path: abs }, { status: 400 });
  }
  const finalBuf = buf as Buffer;
  const binary = looksBinary(finalBuf);
  const result: Result = {
    path: abs,
    size: stat.size,
    truncated,
    binary,
    content: binary ? '' : finalBuf.toString('utf8'),
  };
  return Response.json(result);
}
