'use client';

import { NotebookPen } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
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
  stripe: 'bg-orange-400/70',
  icon: 'text-orange-400',
};

export function NotebookEditToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const notebookPath = typeof r.notebook_path === 'string' ? r.notebook_path : '';
  const cellId = typeof r.cell_id === 'string' ? r.cell_id : '';
  const cellType = typeof r.cell_type === 'string' ? r.cell_type : '';
  const editMode = typeof r.edit_mode === 'string' ? r.edit_mode : 'replace';
  const newSource = typeof r.new_source === 'string' ? r.new_source : '';
  const status = statusOf(block.result);
  const isLatest = useIsLatestAutoOpen(block.id);

  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate">{shortPath(notebookPath)}</span>
      <span className="shrink-0 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] text-orange-300">
        {editMode}
      </span>
      {cellType && (
        <span className="shrink-0 text-muted-foreground/70">{cellType}</span>
      )}
    </span>
  );

  return (
    <ToolShell
      name="NotebookEdit"
      Icon={NotebookPen}
      tone={tone}
      summary={summary}
      status={status}
      forceOpen={isLatest}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Notebook</FieldLabel>
            <div className="font-mono text-[11.5px] text-foreground/90">{notebookPath}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {cellId && (
              <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                cell_id: {cellId}
              </span>
            )}
            <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] text-orange-200">
              edit_mode: {editMode}
            </span>
            {cellType && (
              <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                {cellType}
              </span>
            )}
          </div>
          <div>
            <FieldLabel>New source</FieldLabel>
            <CodeBlock className="bg-orange-950/20">{newSource || '(empty)'}</CodeBlock>
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
