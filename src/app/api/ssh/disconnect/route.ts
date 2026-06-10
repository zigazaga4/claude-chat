import type { NextRequest } from 'next/server';
import { parseCwd } from '@/lib/cwd';
import { getWorkspace } from '@/server/workspaces';
import { disconnectHost, type ConnectOpts } from '@/server/sshHosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { cwd?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.cwd) {
    return Response.json({ error: 'cwd required' }, { status: 400 });
  }
  let parsed;
  try {
    parsed = parseCwd(body.cwd);
  } catch {
    return Response.json({ error: 'invalid cwd' }, { status: 400 });
  }
  if (parsed.kind !== 'ssh') {
    return Response.json({ ok: true });
  }
  const ws = getWorkspace(body.cwd);
  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws?.sshIdentityPath ?? null,
    useAgent: ws?.sshUseAgent ?? false,
  };
  disconnectHost(opts);
  return Response.json({ ok: true });
}
