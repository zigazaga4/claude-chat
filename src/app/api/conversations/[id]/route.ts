import type { NextRequest } from 'next/server';
import {
  deleteConversation,
  keepConversation,
  moveConversation,
  type MoveConversationResult,
} from '@/server/conversations';

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

/**
 * How a failed move is reported. Everything except the last one is the caller
 * asking for something impossible; `transcript-move-failed` is the filesystem
 * saying no, which is ours to own.
 */
const MOVE_ERRORS: Record<
  Extract<MoveConversationResult, { ok: false }>['reason'],
  { status: number; message: string }
> = {
  'not-found': { status: 404, message: 'That conversation no longer exists.' },
  'unknown-destination': {
    status: 400,
    message: 'That folder is not one of your workspaces.',
  },
  'same-workspace': {
    status: 400,
    message: 'The conversation is already in that folder.',
  },
  'transcript-conflict': {
    status: 409,
    message:
      'A transcript with this id already exists in the destination folder, so moving would overwrite it.',
  },
  'transcript-move-failed': {
    status: 500,
    message: 'The conversation transcript could not be moved, so nothing was changed.',
  },
};

/**
 * Partial update of one conversation. Two are supported:
 *
 *   `{ keep: true }`  — promote a throwaway into a saved conversation.
 *   `{ cwd, from? }`  — move it into another workspace. `from` only matters for
 *                       a session the CLI wrote that this app has never stored,
 *                       where it names the folder the caller listed it under.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  let body: { keep?: boolean; cwd?: unknown; from?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.cwd === 'string' && body.cwd) {
    const result = moveConversation(id, body.cwd, {
      fromCwd: typeof body.from === 'string' && body.from ? body.from : undefined,
    });
    if (!result.ok) {
      const { status, message } = MOVE_ERRORS[result.reason];
      return Response.json(
        // The detail is the underlying OS error and is worth surfacing — a move
        // that failed on a full disk should not read the same as one that
        // failed on a permission bit.
        { error: result.detail ? `${message} (${result.detail})` : message },
        { status },
      );
    }
    return Response.json({
      ok: true,
      moved: true,
      from: result.from,
      to: result.to,
      transcriptMoved: result.transcriptMoved,
    });
  }

  if (body.keep !== true) {
    return Response.json(
      { error: 'keep: true or cwd: "<folder>" is required' },
      { status: 400 },
    );
  }
  const kept = keepConversation(id);
  return Response.json({ ok: true, kept });
}
