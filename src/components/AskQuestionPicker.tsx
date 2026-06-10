'use client';

import { useMemo, useState } from 'react';
import { ArrowUp, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PendingQuestion } from '@/lib/types';

const OTHER = '__other__';

type Selection = {
  /** For single-select: the option label OR the OTHER sentinel. Empty if nothing yet. */
  picked: string;
  /** For multi-select: chosen option labels (and possibly OTHER sentinel). */
  pickedSet: Set<string>;
  /** Free-text "Other" answer when OTHER is picked. */
  other: string;
};

function makeInitial(pq: PendingQuestion): Map<string, Selection> {
  const m = new Map<string, Selection>();
  for (const q of pq.questions) {
    m.set(q.question, { picked: '', pickedSet: new Set(), other: '' });
  }
  return m;
}

function joinAnswer(sel: Selection, multi: boolean): string {
  if (multi) {
    const parts: string[] = [];
    for (const p of sel.pickedSet) {
      if (p === OTHER) {
        if (sel.other.trim()) parts.push(sel.other.trim());
      } else {
        parts.push(p);
      }
    }
    return parts.join(', ');
  }
  if (sel.picked === OTHER) return sel.other.trim();
  return sel.picked;
}

type Props = {
  pending: PendingQuestion;
  onSubmit: (toolUseId: string, answers: Record<string, string>) => void;
  disabled?: boolean;
};

export default function AskQuestionPicker({ pending, onSubmit, disabled }: Props) {
  const [sel, setSel] = useState<Map<string, Selection>>(() => makeInitial(pending));

  const ready = useMemo(() => {
    for (const q of pending.questions) {
      const s = sel.get(q.question);
      if (!s) return false;
      const ans = joinAnswer(s, !!q.multiSelect);
      if (!ans) return false;
    }
    return true;
  }, [pending, sel]);

  const submit = () => {
    if (!ready || disabled) return;
    const out: Record<string, string> = {};
    for (const q of pending.questions) {
      const s = sel.get(q.question)!;
      out[q.question] = joinAnswer(s, !!q.multiSelect);
    }
    onSubmit(pending.toolUseId, out);
  };

  return (
    // Capped to the viewport so a long question list scrolls inside the
    // panel instead of pushing the composer off-screen. Header and the
    // submit row stay pinned; only the questions scroll.
    <div className="flex max-h-[55vh] flex-col gap-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-amber-300/90">
        <HelpCircle className="h-3.5 w-3.5" />
        <span>Claude is asking{pending.questions.length > 1 ? ` ${pending.questions.length} questions` : ''}</span>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      {pending.questions.map((q) => {
        const s = sel.get(q.question)!;
        const isMulti = !!q.multiSelect;
        return (
          <div
            key={q.question}
            className="rounded-xl border border-amber-400/30 bg-amber-500/[0.04] p-3"
          >
            <div className="mb-2 flex items-start gap-2">
              {q.header && (
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-200">
                  {q.header}
                </span>
              )}
              <span className="text-[13px] font-medium leading-snug text-foreground">
                {q.question}
              </span>
            </div>
            <div className="grid gap-1.5">
              {q.options.map((opt) => {
                const checked = isMulti
                  ? s.pickedSet.has(opt.label)
                  : s.picked === opt.label;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setSel((prev) => {
                        const next = new Map(prev);
                        const cur = next.get(q.question)!;
                        if (isMulti) {
                          const ps = new Set(cur.pickedSet);
                          if (ps.has(opt.label)) ps.delete(opt.label);
                          else ps.add(opt.label);
                          next.set(q.question, { ...cur, pickedSet: ps });
                        } else {
                          next.set(q.question, { ...cur, picked: opt.label });
                        }
                        return next;
                      });
                    }}
                    className={cn(
                      'group flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                      checked
                        ? 'border-amber-300/70 bg-amber-300/15 text-amber-50'
                        : 'border-border/60 bg-card/40 text-foreground/85 hover:border-amber-300/50 hover:bg-amber-500/[0.08]',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border',
                        isMulti ? 'rounded-sm' : 'rounded-full',
                        checked
                          ? 'border-amber-300 bg-amber-300/80'
                          : 'border-muted-foreground/50 bg-transparent',
                      )}
                    >
                      {checked && (
                        <span
                          className={cn(
                            'block h-1.5 w-1.5 bg-background',
                            isMulti ? 'rounded-[1px]' : 'rounded-full',
                          )}
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-tight">{opt.label}</span>
                      {opt.description && (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/90">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              <OtherRow
                isMulti={isMulti}
                picked={isMulti ? s.pickedSet.has(OTHER) : s.picked === OTHER}
                value={s.other}
                disabled={!!disabled}
                onPick={() =>
                  setSel((prev) => {
                    const next = new Map(prev);
                    const cur = next.get(q.question)!;
                    if (isMulti) {
                      const ps = new Set(cur.pickedSet);
                      if (ps.has(OTHER)) ps.delete(OTHER);
                      else ps.add(OTHER);
                      next.set(q.question, { ...cur, pickedSet: ps });
                    } else {
                      next.set(q.question, { ...cur, picked: OTHER });
                    }
                    return next;
                  })
                }
                onChange={(v) =>
                  setSel((prev) => {
                    const next = new Map(prev);
                    const cur = next.get(q.question)!;
                    next.set(q.question, { ...cur, other: v });
                    return next;
                  })
                }
              />
            </div>
          </div>
        );
      })}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!ready || disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            ready && !disabled
              ? 'bg-amber-400 text-black hover:bg-amber-300'
              : 'cursor-not-allowed bg-muted text-muted-foreground',
          )}
        >
          <ArrowUp className="h-3.5 w-3.5" />
          Send answer{pending.questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}

function OtherRow({
  isMulti,
  picked,
  value,
  disabled,
  onPick,
  onChange,
}: {
  isMulti: boolean;
  picked: boolean;
  value: string;
  disabled: boolean;
  onPick: () => void;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]',
        picked
          ? 'border-amber-300/70 bg-amber-300/10'
          : 'border-border/60 bg-card/30',
      )}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className={cn(
          'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border',
          isMulti ? 'rounded-sm' : 'rounded-full',
          picked
            ? 'border-amber-300 bg-amber-300/80'
            : 'border-muted-foreground/50',
        )}
        aria-label="Other"
      >
        {picked && (
          <span
            className={cn(
              'block h-1.5 w-1.5 bg-background',
              isMulti ? 'rounded-[1px]' : 'rounded-full',
            )}
          />
        )}
      </button>
      <div className="flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
          Other
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (!picked && e.target.value) onPick();
          }}
          disabled={disabled}
          placeholder="Type your own answer..."
          className="mt-0.5 w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
        />
      </div>
    </div>
  );
}
