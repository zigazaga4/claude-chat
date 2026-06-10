'use client';

import { FileText } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import {
  CodeBlock,
  FieldLabel,
  ToolShell,
  asInputRecord,
  shortPath,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-sky-400/70',
  icon: 'text-sky-400',
};

export function ReadToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const filePath = typeof r.file_path === 'string' ? r.file_path : '';
  const offset = typeof r.offset === 'number' ? r.offset : null;
  const limit = typeof r.limit === 'number' ? r.limit : null;
  const status = statusOf(block.result);

  const range =
    offset != null || limit != null
      ? `lines ${offset ?? 1}${limit != null ? `-${(offset ?? 1) + limit - 1}` : '+'}`
      : null;

  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate">{shortPath(filePath)}</span>
      {range && (
        <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
          {range}
        </span>
      )}
    </span>
  );

  return (
    <ToolShell
      name="Read"
      Icon={FileText}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>File</FieldLabel>
            <div className="font-mono text-[11.5px] text-foreground/90">{filePath}</div>
          </div>
          {block.result && (
            <div>
              <FieldLabel>
                {block.result.isError ? 'Error' : `Contents${range ? ` · ${range}` : ''}`}
              </FieldLabel>
              <CodeBlock>{block.result.content || '(empty)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
