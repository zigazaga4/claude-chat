import type { NextRequest } from 'next/server';
import { injectIntoStream } from '@/server/activeChatStreams';
import type { ImageMediaType } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InjectImagePayload = {
  dataUrl: string;
  mediaType: ImageMediaType;
  name?: string;
};

type InjectRequestBody = {
  /**
   * The first turn's assistantMessageId — established when the original
   * `/api/chat` POST opened the stream. Used to look up the still-running
   * SDK query so the new message gets injected mid-loop.
   */
  streamId: string;
  /** New message text. Empty allowed only when at least one image is attached. */
  prompt: string;
  /** Caller-allocated id for the user message we're injecting. */
  userMessageId: string;
  /** Caller-allocated id for the assistant turn that responds to it. */
  assistantMessageId: string;
  images?: InjectImagePayload[];
};

export async function POST(req: NextRequest) {
  let body: InjectRequestBody;
  try {
    body = (await req.json()) as InjectRequestBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { streamId, prompt, userMessageId, assistantMessageId, images } = body;
  if (!streamId || !userMessageId || !assistantMessageId) {
    return Response.json(
      { error: 'streamId, userMessageId, and assistantMessageId are required' },
      { status: 400 },
    );
  }
  const trimmed = (prompt ?? '').trim();
  if (!trimmed && (!images || images.length === 0)) {
    return Response.json(
      { error: 'prompt or images required' },
      { status: 400 },
    );
  }

  const result = injectIntoStream(streamId, {
    userMessageId,
    assistantMessageId,
    prompt: trimmed,
    images,
  });

  if (!result.ok) {
    // 410 Gone — the stream has already closed (idle-close or abort). The
    // client should fall back to a fresh POST /api/chat for this message.
    return Response.json(
      { ok: false, reason: result.reason },
      { status: 410 },
    );
  }
  return Response.json({ ok: true });
}
