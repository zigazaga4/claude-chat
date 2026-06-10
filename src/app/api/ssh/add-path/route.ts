import type { NextRequest } from 'next/server';
import { buildSshCwd, parseCwd } from '@/lib/cwd';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import {
  getStoredSshPassword,
  getWorkspace,
  upsertSshWorkspace,
} from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/ssh/add-path
 *
 * Register an additional folder under an already-known SSH host. We pull
 * the user/host/port from `anchorCwd` (any workspace already on that host)
 * and lift its identity / agent / stored password so the user doesn't have
 * to re-enter anything. Conversations + remote tools then point at the
 * new path immediately.
 */
type Body = { anchorCwd?: string; newPath?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.anchorCwd || !body.newPath) {
    return Response.json(
      { error: 'anchorCwd and newPath are required' },
      { status: 400 },
    );
  }
  let anchor;
  try {
    anchor = parseCwd(body.anchorCwd);
  } catch {
    return Response.json({ error: 'invalid anchorCwd' }, { status: 400 });
  }
  if (anchor.kind !== 'ssh') {
    return Response.json({ error: 'anchorCwd is not SSH' }, { status: 400 });
  }
  const ws = getWorkspace(body.anchorCwd);
  if (!ws) {
    return Response.json({ error: 'anchor workspace not found' }, { status: 404 });
  }
  const stored = getStoredSshPassword(body.anchorCwd);

  const opts: ConnectOpts = {
    host: anchor.host,
    port: anchor.port,
    user: anchor.user,
    identityPath: ws.sshIdentityPath,
    useAgent: ws.sshUseAgent,
    expectedHostFingerprint: ws.sshKnownHostFp,
    password: stored ?? undefined,
  };

  // Make sure the connection is alive (or can be opened) before we commit
  // the workspace row, so we surface auth failures up front.
  let host;
  try {
    host = await getHost(opts);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'connect failed',
      },
      { status: 502 },
    );
  }

  // Resolve "~" / "~/foo" using the live shell.
  let path = body.newPath.trim() || '~';
  if (path === '~' || path.startsWith('~')) {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';
    path = path === '~' ? home : home + path.slice(1);
  }
  if (!path.startsWith('/')) path = '/' + path;

  const cwd = buildSshCwd({
    user: anchor.user,
    host: anchor.host,
    port: anchor.port,
    path,
  });

  upsertSshWorkspace({
    cwd,
    identityPath: ws.sshIdentityPath,
    useAgent: ws.sshUseAgent,
    knownHostFingerprint: ws.sshKnownHostFp,
    // Mirror the stored password onto the new workspace so reconnects work
    // for it independently. Encryption happens inside upsertSshWorkspace.
    rememberPassword: stored ?? undefined,
  });

  return Response.json({ ok: true, cwd });
}
