import type { NextRequest } from 'next/server';
import { buildSshCwd } from '@/lib/cwd';
import { upsertSshWorkspace } from '@/server/workspaces';
import { getHost, type ConnectOpts } from '@/server/sshHosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  host?: string;
  port?: number;
  user?: string;
  path?: string;
  identityPath?: string | null;
  useAgent?: boolean;
  password?: string;
  rememberPassword?: boolean;
  expectedHostFingerprint?: string | null;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.host || !body.user) {
    return Response.json({ error: 'host and user are required' }, { status: 400 });
  }
  const opts: ConnectOpts = {
    host: body.host,
    port: body.port && body.port > 0 ? body.port : 22,
    user: body.user,
    identityPath: body.identityPath ?? null,
    useAgent: !!body.useAgent,
    password: body.password,
    expectedHostFingerprint: body.expectedHostFingerprint ?? null,
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
  const fp = host.getHostFingerprint();

  let path = body.path?.trim() || '~';
  if (path === '~' || path.startsWith('~')) {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';
    path = path === '~' ? home : home + path.slice(1);
  }
  if (!path.startsWith('/')) path = '/' + path;

  const cwd = buildSshCwd({
    user: opts.user,
    host: opts.host,
    port: opts.port,
    path,
  });
  upsertSshWorkspace({
    cwd,
    identityPath: opts.identityPath,
    useAgent: opts.useAgent,
    knownHostFingerprint: fp,
    rememberPassword:
      body.rememberPassword && body.password ? body.password : undefined,
    forgetPassword: body.rememberPassword === false ? true : undefined,
  });

  return Response.json({ ok: true, cwd, hostFingerprint: fp });
}
