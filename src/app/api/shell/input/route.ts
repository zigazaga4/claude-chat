import type { NextRequest } from 'next/server';
import { writeInput } from '@/server/shellSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { shellId?: string; data?: string };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.shellId || typeof body.data !== 'string') {
    return Response.json(
      { error: 'shellId and data are required' },
      { status: 400 },
    );
  }
  const ok = writeInput(body.shellId, body.data);
  if (!ok) return Response.json({ error: 'shell not found or exited' }, { status: 404 });
  return Response.json({ ok: true });
}
