import type { NextRequest } from 'next/server';
import { deleteConversation, keepConversation } from '@/server/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Discard a conversation — used by throwaway chats, which delete themselves
 * the moment the client stops pointing at them. Deleting an id that's already
 * gone is a success, not a 404: the client fires this best-effort and must
 * never have to care whether it won the race.
 */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  const deleted = deleteConversation(id);
  return Response.json({ ok: true, deleted });
}

/** Promote a throwaway into a saved conversation (`{ keep: true }`). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  let body: { keep?: boolean };
  try {
    body = (await req.json()) as { keep?: boolean };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body.keep !== true) {
    return Response.json({ error: 'keep: true is the only supported patch' }, { status: 400 });
  }
  const kept = keepConversation(id);
  return Response.json({ ok: true, kept });
}
