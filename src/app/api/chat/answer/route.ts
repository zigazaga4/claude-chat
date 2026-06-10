import type { NextRequest } from 'next/server';
import { submitAnswers, type Answers } from '@/server/pendingQuestions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AnswerRequest = {
  toolUseId: string;
  answers: Answers;
};

export async function POST(req: NextRequest) {
  let body: AnswerRequest;
  try {
    body = (await req.json()) as AnswerRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { toolUseId, answers } = body;
  if (!toolUseId || !answers || typeof answers !== 'object') {
    return Response.json(
      { error: 'toolUseId and answers are required' },
      { status: 400 },
    );
  }

  const ok = submitAnswers(toolUseId, answers);
  if (!ok) {
    return Response.json(
      { error: 'No pending question for that toolUseId' },
      { status: 404 },
    );
  }
  return Response.json({ ok: true });
}
