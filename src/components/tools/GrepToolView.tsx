'use client';

import { Search } from 'lucide-react';
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

export function GrepToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const pattern = typeof r.pattern === 'string' ? r.pattern : '';
  const path = typeof r.path === 'string' ? r.path : '';
  const glob = typeof r.glob === 'string' ? r.glob : '';
  const fileType = typeof r.type === 'string' ? r.type : '';
  const outputMode = typeof r.output_mode === 'string' ? r.output_mode : 'files_with_matches';
  const caseInsensitive = !!r['-i'];
  const multiline = !!r.multiline;
  const status = statusOf(block.result);

  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate font-mono">/{pattern}/</span>
      {(path || glob || fileType) && (
        <span className="shrink-0 truncate text-muted-foreground/70">
          in {shortPath(path || glob || fileType, 32)}
        </span>
      )}
      <span className="shrink-0 rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[10px] text-cyan-300">
        {outputMode === 'content' ? 'content' : outputMode === 'count' ? 'count' : 'files'}
      </span>
    </span>
  );

  const flags = [
    caseInsensitive && '-i',
    multiline && '--multiline',
    fileType && `--type=${fileType}`,
    glob && `--glob=${glob}`,
  ].filter(Boolean) as string[];

  return (
    <ToolShell
      name="Grep"
      Icon={Search}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Pattern</FieldLabel>
            <CodeBlock className="bg-cyan-950/30 text-cyan-200" maxHeight="max-h-24">
              {pattern}
            </CodeBlock>
          </div>
          {(path || flags.length > 0) && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {path && (
                <div>
                  <FieldLabel>Path</FieldLabel>
                  <div className="font-mono text-[11.5px] text-foreground/90">{path}</div>
                </div>
              )}
              {flags.length > 0 && (
                <div>
                  <FieldLabel>Flags</FieldLabel>
                  <div className="flex flex-wrap gap-1">
                    {flags.map((f) => (
                      <span
                        key={f}
                        className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10.5px] text-cyan-200"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Output'}</FieldLabel>
              <CodeBlock>{block.result.content || '(no matches)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
