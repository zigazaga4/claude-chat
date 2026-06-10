'use client';

import { Bot } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import {
  CodeBlock,
  FieldLabel,
  ToolShell,
  asInputRecord,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-fuchsia-400/70',
  icon: 'text-fuchsia-400',
};

export function TaskToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const description = typeof r.description === 'string' ? r.description : '';
  const subagent = typeof r.subagent_type === 'string' ? r.subagent_type : 'general-purpose';
  const prompt = typeof r.prompt === 'string' ? r.prompt : '';
  const model = typeof r.model === 'string' ? r.model : '';
  const status = statusOf(block.result);

  const summary = (
    <span className="flex items-center gap-2">
      <span className="shrink-0 rounded-full bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] text-fuchsia-300">
        {subagent}
      </span>
      <span className="truncate">{description || prompt.slice(0, 60)}</span>
    </span>
  );

  return (
    <ToolShell
      name="Task"
      Icon={Bot}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[11px] font-medium text-fuchsia-200">
              {subagent}
            </span>
            {model && (
              <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                model: {model}
              </span>
            )}
          </div>
          {description && (
            <div>
              <FieldLabel>Description</FieldLabel>
              <div className="text-[11.5px] text-foreground/90">{description}</div>
            </div>
          )}
          <div>
            <FieldLabel>Prompt</FieldLabel>
            <CodeBlock className="bg-fuchsia-950/20">{prompt || '(none)'}</CodeBlock>
          </div>
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Agent result'}</FieldLabel>
              <CodeBlock>{block.result.content || '(empty)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
