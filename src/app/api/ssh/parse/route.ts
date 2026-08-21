import type { NextRequest } from 'next/server';
import { resolveSshCommand } from '@/server/sshCommand';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { command?: string };

/**
 * POST /api/ssh/parse { command: "ssh leonard" }
 *
 * Resolves a literal ssh command (incl. ~/.ssh/config Host aliases) into the
 * concrete { host, port, user, identityPath } the test/connect/browse
 * endpoints already consume. No connection is made here — it's pure parsing.
 */
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const result = resolveSshCommand(body.command ?? '');
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 200 });
  }
  return Response.json({
    ok: true,
    host: result.host,
    port: result.port,
    user: result.user,
    identityPath: result.identityPath,
    alias: result.alias,
    label: result.label,
  });
}
