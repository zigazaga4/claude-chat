'use client';

import { FolderTree } from 'lucide-react';
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
  stripe: 'bg-slate-400/70',
  icon: 'text-slate-300',
};

export function LSToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const path = typeof r.path === 'string' ? r.path : '';
  const ignore = Array.isArray(r.ignore) ? r.ignore : null;
  const status = statusOf(block.result);

  const summary = <span className="truncate">{shortPath(path)}</span>;

  return (
    <ToolShell
      name="LS"
      Icon={FolderTree}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Path</FieldLabel>
            <div className="font-mono text-[11.5px] text-foreground/90">{path}</div>
          </div>
          {ignore && ignore.length > 0 && (
            <div>
              <FieldLabel>Ignore</FieldLabel>
              <div className="flex flex-wrap gap-1">
                {ignore.map((p, i) => (
                  <span
                    key={`${i}-${String(p)}`}
                    className="rounded bg-slate-500/15 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-200"
                  >
                    {String(p)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Listing'}</FieldLabel>
              <CodeBlock>{block.result.content || '(empty)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
