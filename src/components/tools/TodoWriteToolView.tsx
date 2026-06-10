'use client';

import { Check, Circle, ListChecks, Loader2 } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import { cn } from '@/lib/cn';
import {
  FieldLabel,
  ToolShell,
  asInputRecord,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-indigo-400/70',
  icon: 'text-indigo-400',
};

type Todo = {
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

function asTodos(input: unknown): Todo[] {
  const r = asInputRecord(input);
  if (!Array.isArray(r.todos)) return [];
  const out: Todo[] = [];
  for (const t of r.todos) {
    const rec = asInputRecord(t);
    const content = typeof rec.content === 'string' ? rec.content : '';
    if (!content) continue;
    const status =
      rec.status === 'in_progress' || rec.status === 'completed' || rec.status === 'pending'
        ? rec.status
        : undefined;
    const activeForm = typeof rec.activeForm === 'string' ? rec.activeForm : undefined;
    out.push({ content, status, activeForm });
  }
  return out;
}

export function TodoWriteToolView({ block }: { block: ToolUseBlock }) {
  const todos = asTodos(block.input);
  const status = statusOf(block.result);

  const counts = todos.reduce(
    (acc, t) => {
      if (t.status === 'completed') acc.completed += 1;
      else if (t.status === 'in_progress') acc.inProgress += 1;
      else acc.pending += 1;
      return acc;
    },
    { pending: 0, inProgress: 0, completed: 0 },
  );

  const summary = (
    <span className="flex items-center gap-2">
      <span>{todos.length} todo{todos.length === 1 ? '' : 's'}</span>
      <span className="shrink-0 text-muted-foreground/70">
        {counts.completed}/{todos.length} done
      </span>
    </span>
  );

  return (
    <ToolShell
      name="TodoWrite"
      Icon={ListChecks}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2">
          {todos.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/80">No todos.</div>
          ) : (
            <ul className="space-y-1">
              {todos.map((t, i) => (
                <TodoRow key={i} todo={t} />
              ))}
            </ul>
          )}
          {block.result?.isError && (
            <div>
              <FieldLabel>Error</FieldLabel>
              <div className="font-mono text-[11px] text-red-300">{block.result.content}</div>
            </div>
          )}
        </div>
      }
    />
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const isDone = todo.status === 'completed';
  const isActive = todo.status === 'in_progress';
  const label = isActive && todo.activeForm ? todo.activeForm : todo.content;

  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {isDone ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        ) : isActive ? (
          <Loader2 className="h-3 w-3 animate-spin text-indigo-300" />
        ) : (
          <Circle className="h-3 w-3 text-muted-foreground/60" />
        )}
      </span>
      <span
        className={cn(
          'text-[12px] leading-relaxed',
          isDone && 'text-muted-foreground/70 line-through',
          isActive && 'font-medium text-indigo-200',
          !isDone && !isActive && 'text-foreground/90',
        )}
      >
        {label}
      </span>
    </li>
  );
}
