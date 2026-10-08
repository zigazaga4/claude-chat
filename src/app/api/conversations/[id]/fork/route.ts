import type { NextRequest } from 'next/server';
import {
  forkConversationAt,
  type ForkConversationResult,
} from '@/server/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** How a refused or failed rewind is reported. Only the last is ours to own. */
const FORK_ERRORS: Record<
  Extract<ForkConversationResult, { ok: false }>['reason'],
  { status: number; message: string }
> = {
  'not-found': {
    status: 404,
    message: 'That message or conversation no longer exists.',
  },
  'not-sdk': {
    status: 400,
    message: 'Rewind is only available for conversations run on the Agent SDK.',
  },
  'not-rewindable': {
    status: 409,
    message:
      'This message cannot be rewound to — it was recorded before rewind support, or its turn never reached the transcript.',
  },
  'fork-failed': {
    status: 500,
    message: 'The conversation could not be copied, so nothing was changed.',
  },
};

/**
 * "Rewind to here": fork the conversation at `messageId` into a new one. The
 * original is never modified. Body: `{ messageId: string }`.
 *
 * Success is `{ ok, conversationId, cwd, backend, prefill? }`. `conversationId`
 * is null when rewinding the first message — there is nothing to copy, so the
 * client starts a fresh conversation with `prefill` instead.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  let body: { messageId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.messageId !== 'string' || !body.messageId) {
    return Response.json({ error: 'messageId is required' }, { status: 400 });
  }

  const result = await forkConversationAt(id, body.messageId);
  if (!result.ok) {
    const { status, message } = FORK_ERRORS[result.reason];
    return Response.json(
      { error: result.detail ? `${message} (${result.detail})` : message },
      { status },
    );
  }
  return Response.json({
    ok: true,
    conversationId: result.conversationId,
    cwd: result.cwd,
    backend: result.backend,
    ...(result.prefill != null ? { prefill: result.prefill } : {}),
  });
}
