import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { NextRequest } from 'next/server';
import {
  SUGGESTION_MODEL_ID,
  isValidEffort,
  type EffortLevel,
  type EffortSuggestion,
} from '@/lib/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The classifier's whole job is to map a request to a thinking-effort level.
 * It runs as a single-shot, tool-less query so it stays fast and never touches
 * the filesystem — it only reads the user's prompt and emits one JSON object.
 */
const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for an autonomous coding agent. Given a user's request, decide how much THINKING EFFORT the agent should spend on it. Effort levels, lowest to highest: low, medium, high, xhigh, max.

Guidance:
- low: trivial, mechanical, or purely factual asks — rename a symbol, a one-line tweak, a quick lookup, a greeting.
- medium: small, well-scoped changes with little ambiguity — a single function, a small bug with an obvious cause.
- high: typical multi-step coding work needing real reasoning across a few files.
- xhigh: complex tasks — tricky debugging, cross-cutting refactors, subtle concurrency or algorithmic work, ambiguous requirements that need planning.
- max: the hardest problems — deep architecture or system design, intricate algorithms or proofs, gnarly multi-system debugging where mistakes are costly.

Respond with ONLY a compact JSON object and nothing else — no prose, no markdown, no code fences:
{"effort":"<low|medium|high|xhigh|max>","reason":"<one short sentence, max ~15 words>"}`;

function parseSuggestion(text: string): EffortSuggestion | null {
  // The model is asked for bare JSON, but be defensive: pull the first
  // brace-delimited object out of whatever came back and validate it.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const rawEffort =
      typeof obj.effort === 'string' ? obj.effort.trim().toLowerCase() : '';
    if (!isValidEffort(rawEffort)) return null;
    const effort: EffortLevel = rawEffort;
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    return { effort, reason };
  } catch {
    return null;
  }
}

type SuggestRequest = { prompt?: string };

export async function POST(req: NextRequest) {
  let body: SuggestRequest;
  try {
    body = (await req.json()) as SuggestRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return Response.json({ error: 'prompt is required' }, { status: 400 });
  }

  try {
    const queryInstance = query({
      prompt: `Classify this request:\n\n${prompt}`,
      options: {
        model: SUGGESTION_MODEL_ID,
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        // No thinking, no tools, one turn: this is a cheap classification, not
        // an agent loop. The decision is about which effort the *main* turn
        // should use, so we keep the router itself lightweight and snappy.
        thinking: { type: 'disabled' },
        effort: 'low',
        maxTurns: 1,
        allowedTools: [],
        cwd: os.homedir(),
        env: { ...process.env },
        pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH || 'claude',
      },
    });

    let resultText = '';
    for await (const message of queryInstance) {
      if (req.signal.aborted) {
        try {
          await queryInstance.interrupt();
        } catch {
          /* ignore */
        }
        break;
      }
      if (message.type === 'result' && message.subtype === 'success') {
        resultText = message.result;
      }
    }

    const suggestion = parseSuggestion(resultText);
    if (!suggestion) {
      // Couldn't get a usable recommendation — tell the client so it falls
      // back to sending with the user's currently-selected effort.
      return Response.json({ error: 'no suggestion' }, { status: 502 });
    }
    return Response.json(suggestion);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'classification failed' },
      { status: 500 },
    );
  }
}
