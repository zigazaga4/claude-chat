import type { NextRequest } from 'next/server';
import {
  readSystemPrompt,
  systemPromptPath,
  writeSystemPrompt,
} from '@/server/systemPrompt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/system-prompt — the current operator prompt and where it lives. */
export async function GET() {
  return Response.json({
    prompt: readSystemPrompt(),
    path: systemPromptPath(),
  });
}

/**
 * PUT /api/system-prompt — replace the operator prompt. An empty string
 * clears it. Takes effect on the next chat session start (no restart).
 */
export async function PUT(req: NextRequest) {
  let body: { prompt?: unknown };
  try {
    body = (await req.json()) as { prompt?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.prompt !== 'string') {
    return Response.json({ error: '`prompt` must be a string' }, { status: 400 });
  }
  try {
    writeSystemPrompt(body.prompt);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to write prompt file' },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, path: systemPromptPath() });
}
