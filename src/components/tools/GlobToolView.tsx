'use client';

import { FolderSearch } from 'lucide-react';
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
  stripe: 'bg-cyan-400/70',
  icon: 'text-cyan-400',
};

export function GlobToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const pattern = typeof r.pattern === 'string' ? r.pattern : '';
  const path = typeof r.path === 'string' ? r.path : '';
  const status = statusOf(block.result);

  const matchCount = block.result?.content
    ? block.result.content.split('\n').filter((l) => l.trim()).length
    : null;

  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate font-mono">{pattern}</span>
      {path && (
        <span className="shrink-0 truncate text-muted-foreground/70">in {shortPath(path, 32)}</span>
      )}
      {matchCount != null && (
        <span className="shrink-0 rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[10px] text-cyan-300">
          {matchCount} match{matchCount === 1 ? '' : 'es'}
        </span>
      )}
    </span>
  );

  return (
    <ToolShell
      name="Glob"
      Icon={FolderSearch}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Pattern</FieldLabel>
            <div className="font-mono text-[11.5px] text-cyan-200">{pattern}</div>
          </div>
          {path && (
            <div>
              <FieldLabel>Path</FieldLabel>
              <div className="font-mono text-[11.5px] text-foreground/90">{path}</div>
            </div>
          )}
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Matches'}</FieldLabel>
              <CodeBlock>{block.result.content || '(no matches)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
