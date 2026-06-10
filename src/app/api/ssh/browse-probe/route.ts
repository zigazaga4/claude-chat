import path from 'node:path';
import type { NextRequest } from 'next/server';
import { getHost, type ConnectOpts } from '@/server/sshHosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Entry = { name: string; path: string };

/**
 * GET /api/ssh/browse-probe?host=...&port=...&user=...&identityPath=...&useAgent=1&path=/abs
 *
 * Used by the Connect-SSH modal to pick a starting folder before a
 * workspace is persisted. Reuses the connection pool, so the live channel
 * is shared with subsequent /api/ssh/connect (which seals the workspace).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const host = url.searchParams.get('host')?.trim();
  const user = url.searchParams.get('user')?.trim();
  const portStr = url.searchParams.get('port') ?? '22';
  const identityPath = url.searchParams.get('identityPath')?.trim() || null;
  const useAgent = url.searchParams.get('useAgent') === '1';
  const password = url.searchParams.get('password') || undefined;
  const requested = url.searchParams.get('path');
  if (!host || !user) {
    return Response.json({ error: 'host and user required' }, { status: 400 });
  }
  const opts: ConnectOpts = {
    host,
    port: Number(portStr) || 22,
    user,
    identityPath,
    useAgent,
    password,
  };

  let conn;
  try {
    conn = await getHost(opts);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'connect failed' },
      { status: 502 },
    );
  }

  let target = requested && requested.length > 0 ? requested : '~';
  if (target === '~' || target.startsWith('~')) {
    const home = (await conn.exec('printf %s "$HOME"')).stdout.trim() || '/';
    target = target === '~' ? home : home + target.slice(1);
  }
  if (!target.startsWith('/')) target = '/' + target;
  const home = (await conn.exec('printf %s "$HOME"')).stdout.trim() || '/';

  type ReadDirEntry = { filename: string; longname: string; attrs: { mode: number } };
  const sftp = await conn.sftp();
  const list = await new Promise<ReadDirEntry[] | { __error: string }>((resolve) => {
    sftp.readdir(target, (err, entries) => {
      if (err) resolve({ __error: err.message });
      else resolve(entries as ReadDirEntry[]);
    });
  });
  if ('__error' in list) {
    return Response.json({ error: list.__error, path: target }, { status: 400 });
  }
  const entries: Entry[] = list
    .filter((e) => (e.attrs.mode & 0o170000) === 0o040000)
    .filter((e) => !e.filename.startsWith('.'))
    .map((e) => ({ name: e.filename, path: path.posix.join(target, e.filename) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.posix.dirname(target);
  return Response.json({
    path: target,
    parent: parent === target ? null : parent,
    home,
    entries,
  });
}
