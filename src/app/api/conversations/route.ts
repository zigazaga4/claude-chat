import type { NextRequest } from 'next/server';
import { listConversationsForCwd } from '@/server/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get('cwd');
  if (!cwd) {
    return Response.json({ error: 'cwd query param is required' }, { status: 400 });
  }
  const conversations = listConversationsForCwd(cwd);
  return Response.json({ conversations });
}
