import type { NextRequest } from 'next/server';
import {
  listConversationsForCwd,
  sweepEphemeralConversations,
} from '@/server/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get('cwd');
  if (!cwd) {
    return Response.json({ error: 'cwd query param is required' }, { status: 400 });
  }
  // Cheap piggy-back reap of throwaways a crash or a closed browser stranded.
  // Live ones are touched on every turn, so they never look stale.
  sweepEphemeralConversations();
  const conversations = listConversationsForCwd(cwd);
  return Response.json({ conversations });
}
