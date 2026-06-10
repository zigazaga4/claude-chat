import type { NextRequest } from 'next/server';
import { ensureConversation, getMessagesPage } from '@/server/conversations';
import { setWorkspaceLastConversation } from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 37;

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  const cwd = req.nextUrl.searchParams.get('cwd');
  if (cwd) {
    const now = Date.now();
    ensureConversation(id, cwd, now);
    setWorkspaceLastConversation(cwd, id, now);
  }
  const limitParam = req.nextUrl.searchParams.get('limit');
  const beforeSeqParam = req.nextUrl.searchParams.get('beforeSeq');
  const limit = limitParam ? Number(limitParam) || DEFAULT_LIMIT : DEFAULT_LIMIT;
  const beforeSeq = beforeSeqParam ? Number(beforeSeqParam) : undefined;
  const page = getMessagesPage(id, limit, Number.isFinite(beforeSeq) ? beforeSeq : undefined);
  return Response.json(page);
}
