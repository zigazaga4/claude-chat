import type { NextRequest } from 'next/server';
import { RemoteHost, type ConnectOpts } from '@/server/sshHosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  host?: string;
  port?: number;
  user?: string;
  identityPath?: string | null;
  useAgent?: boolean;
  password?: string;
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
  const probe = new RemoteHost(opts);
  try {
    await probe.connect();
    const fp = probe.getHostFingerprint();
    // Also grab hostname + home dir + uname for the UI.
    const home = (await probe.exec('printf %s "$HOME"')).stdout.trim() || '~';
    const uname = (await probe.exec('uname -a')).stdout.trim();
    const distro =
      (await probe.exec(
        `sh -c "(. /etc/os-release 2>/dev/null && printf %s \\"$PRETTY_NAME\\") || uname -sr"`,
      )).stdout.trim();
    return Response.json({
      ok: true,
      hostFingerprint: fp,
      home,
      uname,
      distro,
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'connection failed',
      },
      { status: 200 },
    );
  } finally {
    probe.close();
  }
}
