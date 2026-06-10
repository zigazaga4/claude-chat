import type { NextRequest } from 'next/server';
import { startSession } from '@/server/shellSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  cwd?: string;
  cols?: number;
  rows?: number;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.cwd || typeof body.cwd !== 'string') {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }
  let session;
  try {
    session = await startSession({
      cwd: body.cwd,
      cols: body.cols,
      rows: body.rows,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed to start shell' },
      { status: 502 },
    );
  }
  return Response.json({
    shellId: session.id,
    cwd: session.cwd,
    kind: session.kind,
    shell: session.shell,
  });
}
