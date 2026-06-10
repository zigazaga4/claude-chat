'use client';

import { FilePlus2 } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import { DiffView } from './DiffView';
import { useIsLatestAutoOpen } from './LatestToolContext';
import {
  CodeBlock,
  FieldLabel,
  ToolShell,
  asInputRecord,
  shortPath,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-violet-400/70',
  icon: 'text-violet-400',
};

export function WriteToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const filePath = typeof r.file_path === 'string' ? r.file_path : '';
  const content = typeof r.content === 'string' ? r.content : '';
  const priorContent = typeof r._priorContent === 'string' ? r._priorContent : null;
  const isOverwrite = priorContent !== null;
  const status = statusOf(block.result);
  const isLatest = useIsLatestAutoOpen(block.id);

  const lineCount = content ? content.split('\n').length : 0;
  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate">{shortPath(filePath)}</span>
      <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300">
        {isOverwrite ? 'overwrite' : 'new file'}
      </span>
      <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
        {lineCount} line{lineCount === 1 ? '' : 's'}
      </span>
    </span>
  );

  return (
    <ToolShell
      name="Write"
      Icon={FilePlus2}
      tone={tone}
      summary={summary}
      status={status}
      forceOpen={isLatest}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>File</FieldLabel>
            <div className="font-mono text-[11.5px] text-foreground/90">{filePath}</div>
          </div>
          <div>
            <FieldLabel>{isOverwrite ? 'Diff (replaced → written)' : 'New file'}</FieldLabel>
            <DiffView prior={priorContent ?? ''} next={content} />
          </div>
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Result'}</FieldLabel>
              <CodeBlock>{block.result.content || '(empty)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
