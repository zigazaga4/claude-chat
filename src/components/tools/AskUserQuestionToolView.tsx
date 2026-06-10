'use client';

import { CheckCircle2, HelpCircle } from 'lucide-react';
import type {
  AskUserQuestionItem,
  AskUserQuestionOption,
  ToolUseBlock,
} from '@/lib/types';
import { cn } from '@/lib/cn';
import {
  FieldLabel,
  ToolShell,
  asInputRecord,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-amber-400/70',
  icon: 'text-amber-300',
};

function asQuestions(input: unknown): AskUserQuestionItem[] {
  const r = asInputRecord(input);
  if (!Array.isArray(r.questions)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const q of r.questions) {
    const qr = asInputRecord(q);
    const question = typeof qr.question === 'string' ? qr.question : '';
    if (!question) continue;
    const header = typeof qr.header === 'string' ? qr.header : undefined;
    const multiSelect = !!qr.multiSelect;
    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(qr.options)) {
      for (const o of qr.options) {
        const or = asInputRecord(o);
        const label = typeof or.label === 'string' ? or.label : '';
        if (!label) continue;
        const opt: AskUserQuestionOption = { label };
        if (typeof or.description === 'string') opt.description = or.description;
        if (typeof or.preview === 'string') opt.preview = or.preview;
        options.push(opt);
      }
    }
    out.push({ question, header, options, multiSelect });
  }
  return out;
}

/** Pull answers from either the live `answers` patch on the block or the tool result JSON. */
function collectAnswers(block: ToolUseBlock): Record<string, string> {
  if (block.answers && typeof block.answers === 'object') return block.answers;
  if (!block.result || block.result.isError) return {};
  try {
    const parsed = JSON.parse(block.result.content) as { answers?: Record<string, string> };
    return parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : {};
  } catch {
    return {};
  }
}

export function AskUserQuestionToolView({ block }: { block: ToolUseBlock }) {
  const questions = asQuestions(block.input);
  const answers = collectAnswers(block);
  const status = statusOf(block.result);
  const answered = Object.keys(answers).length > 0 || status === 'done';

  const summary = (() => {
    if (answered) {
      const first = questions[0]?.question;
      const ans = first ? answers[first] : undefined;
      if (ans) return <span>Answered: {ans}</span>;
      return <span>{questions.length} answered</span>;
    }
    return (
      <span>
        Asking {questions.length} question{questions.length === 1 ? '' : 's'}…
      </span>
    );
  })();

  return (
    <ToolShell
      name="AskUserQuestion"
      Icon={HelpCircle}
      tone={tone}
      summary={summary}
      status={status}
      defaultOpen={!answered}
      body={
        <div className="space-y-3">
          {questions.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/80">
              (no questions in input)
            </div>
          ) : (
            questions.map((q) => {
              const answer = answers[q.question];
              const picked = answer
                ? new Set(answer.split(',').map((s) => s.trim()))
                : new Set<string>();
              return (
                <div
                  key={q.question}
                  className="rounded-lg border border-amber-400/30 bg-amber-500/[0.04] p-2.5"
                >
                  <div className="mb-1.5 flex items-start gap-2">
                    {q.header && (
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-200">
                        {q.header}
                      </span>
                    )}
                    <span className="text-[12.5px] font-medium leading-snug text-foreground">
                      {q.question}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {q.options.map((opt) => {
                      const isChosen = picked.has(opt.label);
                      return (
                        <li
                          key={opt.label}
                          className={cn(
                            'flex items-start gap-2 rounded-md border px-2 py-1 text-[12px]',
                            isChosen
                              ? 'border-amber-300/60 bg-amber-300/15 text-amber-50'
                              : 'border-border/40 bg-card/30 text-foreground/85',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center border',
                              q.multiSelect ? 'rounded-sm' : 'rounded-full',
                              isChosen
                                ? 'border-amber-300 bg-amber-300/80'
                                : 'border-muted-foreground/40',
                            )}
                          >
                            {isChosen && (
                              <span
                                className={cn(
                                  'block h-1.5 w-1.5 bg-background',
                                  q.multiSelect ? 'rounded-[1px]' : 'rounded-full',
                                )}
                              />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block leading-tight">{opt.label}</span>
                            {opt.description && (
                              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/85">
                                {opt.description}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {answer && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      <FieldLabel>
                        <span className="text-emerald-300/80">Answer:</span>
                      </FieldLabel>
                      <span className="font-mono text-emerald-200">{answer}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      }
    />
  );
}
