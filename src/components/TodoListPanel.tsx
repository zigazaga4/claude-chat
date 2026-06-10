'use client';

import { Check, Circle, ListChecks, Loader2 } from 'lucide-react';
import type { ChatMessage, ToolUseBlock } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useInstances } from '@/state/instances';

type Todo = {
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

function extractTodos(messages: ChatMessage[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.type === 'tool_use' && b.name === 'TodoWrite') {
        return parseTodos((b as ToolUseBlock).input);
      }
    }
  }
  return [];
}

function parseTodos(input: unknown): Todo[] {
  if (!input || typeof input !== 'object') return [];
  const r = input as Record<string, unknown>;
  if (!Array.isArray(r.todos)) return [];
  const out: Todo[] = [];
  for (const t of r.todos) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    const content = typeof rec.content === 'string' ? rec.content : '';
    if (!content) continue;
    const status =
      rec.status === 'in_progress' || rec.status === 'completed' || rec.status === 'pending'
        ? (rec.status as Todo['status'])
        : undefined;
    const activeForm = typeof rec.activeForm === 'string' ? rec.activeForm : undefined;
    out.push({ content, status, activeForm });
  }
  return out;
}

export default function TodoListPanel() {
  const { active } = useInstances();
  const todos = extractTodos(active.messages);
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;

  return (
    <div className="rounded-lg border border-indigo-400/30 bg-gradient-to-b from-indigo-500/[0.06] to-card/40 p-2.5 shadow-[0_0_20px_-12px_rgba(129,140,248,0.6)]">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-indigo-300/90">
        <ListChecks className="h-3 w-3" />
        <span>Active todos</span>
        <span className="ml-auto rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[10px] text-indigo-200">
          {completed}/{todos.length}
        </span>
      </div>
      <ul className="scrollbar-thin max-h-64 space-y-1 overflow-y-auto pr-1">
        {todos.map((t, i) => (
          <TodoRow key={i} todo={t} />
        ))}
      </ul>
      {inProgress > 0 && (
        <div className="mt-2 text-[10px] text-indigo-300/70">
          {inProgress} in progress
        </div>
      )}
    </div>
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
          'text-[11.5px] leading-snug',
          isDone && 'text-muted-foreground/60 line-through',
          isActive && 'font-medium text-indigo-200',
          !isDone && !isActive && 'text-foreground/85',
        )}
      >
        {label}
      </span>
    </li>
  );
}
