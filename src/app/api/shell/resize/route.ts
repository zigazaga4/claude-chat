import type { NextRequest } from 'next/server';
import { resize } from '@/server/shellSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { shellId?: string; cols?: number; rows?: number };

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (
    !body.shellId ||
    typeof body.cols !== 'number' ||
    typeof body.rows !== 'number'
  ) {
    return Response.json(
      { error: 'shellId, cols, rows are required' },
      { status: 400 },
    );
  }
  const ok = resize(body.shellId, body.cols, body.rows);
  if (!ok) return Response.json({ error: 'shell not found or exited' }, { status: 404 });
  return Response.json({ ok: true });
}
