import path from 'node:path';
import type { NextRequest } from 'next/server';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';
import { parseCwd } from '@/lib/cwd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/ssh/mkdir
 *
 * Creates a single directory under `parent` on a remote host. Symmetric
 * with /api/ssh/browse + /api/ssh/browse-probe — accepts EITHER `cwd`
 * (uses persisted workspace credentials) OR ad-hoc connection details
 * (`host` / `port` / `user` / etc.) so the same endpoint serves both
 * the in-app folder picker and the connect-modal folder picker.
 *
 * Body: { parent, name, cwd? | host?, port?, user?, identityPath?, useAgent?, password? }
 * Returns: { ok: true, path: string }
 */
type Body = {
  parent?: string;
  name?: string;
  cwd?: string;
  host?: string;
  port?: number;
  user?: string;
  identityPath?: string | null;
  useAgent?: boolean;
  password?: string;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parent = (body.parent || '').trim();
  const name = (body.name || '').trim();
  if (!parent || !name) {
    return Response.json({ error: 'parent and name are required' }, { status: 400 });
  }
  if (name.includes('/') || name === '.' || name === '..' || name.includes('\0')) {
    return Response.json({ error: 'invalid folder name' }, { status: 400 });
  }

  let opts: ConnectOpts;
  if (body.cwd) {
    let parsed;
    try {
      parsed = parseCwd(body.cwd);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'invalid cwd' },
        { status: 400 },
      );
    }
    if (parsed.kind !== 'ssh') {
      return Response.json({ error: 'cwd is not SSH' }, { status: 400 });
    }
    const ws = getWorkspace(body.cwd);
    if (!ws) {
      return Response.json({ error: 'workspace not found' }, { status: 404 });
    }
    const stored = getStoredSshPassword(body.cwd);
    opts = {
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      identityPath: ws.sshIdentityPath,
      useAgent: ws.sshUseAgent,
      expectedHostFingerprint: ws.sshKnownHostFp,
      password: stored ?? undefined,
    };
  } else {
    if (!body.host || !body.user) {
      return Response.json(
        { error: 'cwd OR (host + user) is required' },
        { status: 400 },
      );
    }
    opts = {
      host: body.host,
      port: body.port || 22,
      user: body.user,
      identityPath: body.identityPath ?? null,
      useAgent: !!body.useAgent,
      password: body.password,
    };
  }

  let host;
  try {
    host = await getHost(opts);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'connect failed' },
      { status: 502 },
    );
  }

  // Resolve "~" / "~/foo" against the live home dir for the parent.
  let parentAbs = parent;
  if (parentAbs === '~' || parentAbs.startsWith('~')) {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';
    parentAbs = parentAbs === '~' ? home : home + parentAbs.slice(1);
  }
  if (!parentAbs.startsWith('/')) parentAbs = '/' + parentAbs;
  const target = path.posix.join(parentAbs, name);

  const sftp = await host.sftp();
  const result = await new Promise<{ ok: true } | { error: string }>((resolve) => {
    sftp.mkdir(target, (err) => {
      if (err) resolve({ error: err.message });
      else resolve({ ok: true });
    });
  });
  if ('error' in result) {
    return Response.json({ error: result.error, path: target }, { status: 400 });
  }
  return Response.json({ ok: true, path: target });
}
