'use client';

import { Terminal } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import {
  CodeBlock,
  FieldLabel,
  ToolShell,
  asInputRecord,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-emerald-400/70',
  icon: 'text-emerald-400',
};

export function BashToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const command = typeof r.command === 'string' ? r.command : '';
  const description = typeof r.description === 'string' ? r.description : '';
  const timeout = typeof r.timeout === 'number' ? r.timeout : null;
  const background = !!r.run_in_background;
  const status = statusOf(block.result);

  const summary = command ? <span className="font-mono">$ {command}</span> : description;

  return (
    <ToolShell
      name={background ? 'Bash (bg)' : 'Bash'}
      Icon={Terminal}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          {description && (
            <div>
              <FieldLabel>Description</FieldLabel>
              <div className="text-[11.5px] text-muted-foreground/90">{description}</div>
            </div>
          )}
          <div>
            <FieldLabel>
              Command{timeout != null ? ` · timeout ${timeout}ms` : ''}
            </FieldLabel>
            <CodeBlock className="bg-black/60 text-emerald-200">
              {`$ ${command || '(no command)'}`}
            </CodeBlock>
          </div>
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error output' : 'Output'}</FieldLabel>
              <CodeBlock className="bg-black/60 text-foreground/90">
                {block.result.content || '(empty)'}
              </CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
