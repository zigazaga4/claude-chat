import type { NextRequest } from 'next/server';
import { ensureConversation } from '@/server/conversations';
import { lineCount, readNotebook, writeNotebook } from '@/server/notebook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/conversations/[id]/notebook — the model's notes for this conversation. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  const content = readNotebook(id);
  return Response.json({ content, lineCount: lineCount(content) });
}

/**
 * PUT /api/conversations/[id]/notebook — replace the notes. An empty string
 * clears them. Applies to the conversation's next message (the notebook is
 * read fresh into the system prompt each turn). `cwd` lets us materialize the
 * conversation row first so notes can be added to an as-yet-unsaved session.
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  let body: { content?: unknown; cwd?: unknown };
  try {
    body = (await req.json()) as { content?: unknown; cwd?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.content !== 'string') {
    return Response.json({ error: '`content` must be a string' }, { status: 400 });
  }
  try {
    // Satisfy the conversation_notes → conversations foreign key for sessions
    // that don't have a row yet (e.g. external SDK sessions never opened here).
    if (typeof body.cwd === 'string' && body.cwd) {
      ensureConversation(id, body.cwd, Date.now());
    }
    writeNotebook(id, body.content, Date.now());
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to save notes' },
      { status: 500 },
    );
  }
  const content = body.content;
  return Response.json({ ok: true, lineCount: lineCount(content) });
}
