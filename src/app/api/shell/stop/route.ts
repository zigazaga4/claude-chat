import type { NextRequest } from 'next/server';
import { killSession } from '@/server/shellSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { shellId?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.shellId) {
    return Response.json({ error: 'shellId required' }, { status: 400 });
  }
  killSession(body.shellId);
  return Response.json({ ok: true });
}
