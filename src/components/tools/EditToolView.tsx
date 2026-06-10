'use client';

import { PencilLine } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import { DiffView } from './DiffView';
import { applyEdit } from './diff';
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
  stripe: 'bg-amber-400/70',
  icon: 'text-amber-400',
};

export function EditToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const filePath = typeof r.file_path === 'string' ? r.file_path : '';
  const oldString = typeof r.old_string === 'string' ? r.old_string : '';
  const newString = typeof r.new_string === 'string' ? r.new_string : '';
  const replaceAll = !!r.replace_all;
  const priorContent = typeof r._priorContent === 'string' ? r._priorContent : null;
  const status = statusOf(block.result);
  const isLatest = useIsLatestAutoOpen(block.id);

  // When we have the prior file, build the post-edit version and diff
  // them with line numbers + 3 lines of context. When we don't (read failed
  // or file doesn't exist) fall back to diffing the snippets directly.
  const prior = priorContent ?? oldString;
  const next = priorContent ? applyEdit(priorContent, oldString, newString, replaceAll) : newString;

  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate">{shortPath(filePath)}</span>
      {replaceAll && (
        <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
          replace_all
        </span>
      )}
    </span>
  );

  return (
    <ToolShell
      name="Edit"
      Icon={PencilLine}
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
            <FieldLabel>Diff</FieldLabel>
            <DiffView prior={prior} next={next} context={3} />
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
