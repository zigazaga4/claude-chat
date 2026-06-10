import path from 'node:path';
import type { NextRequest } from 'next/server';
import type { ConnectOpts } from '@/server/sshHosts';
import { getHost } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';
import { parseCwd } from '@/lib/cwd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Entry = { name: string; path: string };

/**
 * GET /api/ssh/browse?cwd=ssh://user@host:port/anything&path=/abs/dir
 *
 * Uses the connection details persisted on the workspace identified by
 * `cwd`. Returns the same shape as /api/fs/browse so the FolderPicker
 * stays symmetrical.
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
  if (parsed.kind !== 'ssh') {
    return Response.json({ error: 'cwd is not an SSH workspace' }, { status: 400 });
  }
  // Look up persisted credentials. We pull these from any workspace row
  // matching the same host/user/port — typically the caller passes its own
  // workspace cwd, but allow any sibling under the same connection.
  const workspace = getWorkspace(cwd);
  if (!workspace) {
    return Response.json({ error: 'workspace not found' }, { status: 404 });
  }
  const stored = getStoredSshPassword(cwd);
  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: workspace.sshIdentityPath,
    useAgent: workspace.sshUseAgent,
    expectedHostFingerprint: workspace.sshKnownHostFp,
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

  const sftp = await host.sftp();
  let target = requested && requested.length > 0 ? requested : parsed.path || '~';
  if (target === '~' || target.startsWith('~')) {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';
    target = target === '~' ? home : home + target.slice(1);
  }
  if (!target.startsWith('/')) target = '/' + target;
  const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';

  type ReadDirEntry = { filename: string; longname: string; attrs: { mode: number } };
  const list = await new Promise<ReadDirEntry[]>((resolve, reject) => {
    sftp.readdir(target, (err, entries) => {
      if (err) reject(err);
      else resolve(entries as ReadDirEntry[]);
    });
  }).catch((err: Error) => {
    return { __error: err.message } as unknown as ReadDirEntry[];
  });

  if ('__error' in (list as object)) {
    const err = (list as unknown as { __error: string }).__error;
    return Response.json({ error: err, path: target }, { status: 400 });
  }

  // Filter to directories only (mode bit 0o040000 = S_IFDIR).
  const entries: Entry[] = (list as ReadDirEntry[])
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
