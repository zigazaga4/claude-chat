import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { parseCwd } from '@/lib/cwd';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Entry = {
  name: string;
  path: string;
  /** 'dir' or 'file'. Symlinks are resolved into one of the two. */
  kind: 'dir' | 'file';
};

type Result = {
  path: string;
  parent: string | null;
  entries: Entry[];
  error?: string;
};

/**
 * GET /api/fs/tree?cwd=<workspace>&path=<abs>
 *
 * Lists files + directories at `path` (defaults to the workspace root) on
 * either the local filesystem or the SSH host the workspace points at.
 * Hidden entries (dot-prefixed) are skipped — symmetry with the existing
 * /api/fs/browse and /api/ssh/browse handlers.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get('cwd');
  const requested = url.searchParams.get('path');
  if (!cwd) {
    return Response.json({ error: 'cwd query param is required' }, { status: 400 });
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

  const target = (requested && requested.length > 0 ? requested : parsed.path) || '/';

  if (parsed.kind === 'local') {
    try {
      const abs = path.resolve(target);
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        return Response.json({ error: 'not a directory', path: abs }, { status: 400 });
      }
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      const entries: Entry[] = [];
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        let kind: 'dir' | 'file';
        if (d.isDirectory()) kind = 'dir';
        else if (d.isFile()) kind = 'file';
        else if (d.isSymbolicLink()) {
          // Resolve symlinks once so the UI doesn't have to.
          try {
            const sub = await fs.stat(path.join(abs, d.name));
            kind = sub.isDirectory() ? 'dir' : 'file';
          } catch {
            continue;
          }
        } else continue;
        entries.push({ name: d.name, path: path.join(abs, d.name), kind });
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const parent = path.dirname(abs);
      const result: Result = {
        path: abs,
        parent: parent === abs ? null : parent,
        entries,
      };
      return Response.json(result);
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

  type ReadDirEntry = { filename: string; longname: string; attrs: { mode: number } };
  const sftp = await host.sftp();
  const list = await new Promise<ReadDirEntry[] | { __error: string }>((resolve) => {
    sftp.readdir(abs, (err, entries) => {
      if (err) resolve({ __error: err.message });
      else resolve(entries as ReadDirEntry[]);
    });
  });
  if ('__error' in list) {
    return Response.json({ error: list.__error, path: abs }, { status: 400 });
  }

  const entries: Entry[] = [];
  for (const e of list) {
    if (e.filename.startsWith('.')) continue;
    const t = e.attrs.mode & 0o170000;
    let kind: 'dir' | 'file';
    if (t === 0o040000) kind = 'dir';
    else if (t === 0o100000) kind = 'file';
    else if (t === 0o120000) {
      // symlink — resolve via stat
      try {
        const subStat = await new Promise<{ mode: number } | null>((resolve) => {
          sftp.stat(path.posix.join(abs, e.filename), (err, st) => {
            if (err || !st) resolve(null);
            else resolve(st);
          });
        });
        if (!subStat) continue;
        kind = (subStat.mode & 0o170000) === 0o040000 ? 'dir' : 'file';
      } catch {
        continue;
      }
    } else continue;
    entries.push({
      name: e.filename,
      path: path.posix.join(abs, e.filename),
      kind,
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.posix.dirname(abs);
  const result: Result = {
    path: abs,
    parent: parent === abs ? null : parent,
    entries,
  };
  return Response.json(result);
}
