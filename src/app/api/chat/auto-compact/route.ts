import type { NextRequest } from 'next/server';
import { setStreamAutoCompactAt } from '@/server/activeChatStreams';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AutoCompactBody = {
  /** The first turn's assistantMessageId — the same key `/api/chat/inject` uses. */
  streamId: string;
  /** New threshold in tokens; 0 turns auto-compact off. */
  autoCompactAt: number;
};

/**
 * Move the auto-compact threshold of a stream that is already running.
 *
 * The threshold normally rides on the request that opens the stream, so a
 * change made while a loop is in flight would otherwise do nothing until the
 * next message — the worst moment for a setting to silently not apply, since
 * the loop that needs it is the one on screen.
 *
 * 410 means there was nothing to update (the stream finished, or is on an
 * engine with no compaction); the client ignores it, because the next message
 * opens a stream that carries the new value anyway.
 */
export async function POST(req: NextRequest) {
  let body: AutoCompactBody;
  try {
    body = (await req.json()) as AutoCompactBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { streamId, autoCompactAt } = body;
  if (!streamId || typeof autoCompactAt !== 'number') {
    return Response.json(
      { error: 'streamId and a numeric autoCompactAt are required' },
      { status: 400 },
    );
  }
  if (!setStreamAutoCompactAt(streamId, autoCompactAt)) {
    return Response.json({ ok: false, reason: 'no-active-stream' }, { status: 410 });
  }
  return Response.json({ ok: true });
}
