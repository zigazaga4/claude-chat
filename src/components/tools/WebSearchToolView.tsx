'use client';

import { SearchCheck } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import {
  CodeBlock,
  FieldLabel,
  ToolShell,
  asInputRecord,
  statusOf,
} from './ToolShell';

const tone = {
  stripe: 'bg-rose-400/70',
  icon: 'text-rose-400',
};

export function WebSearchToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const query = typeof r.query === 'string' ? r.query : '';
  const allowed = Array.isArray(r.allowed_domains) ? (r.allowed_domains as unknown[]) : [];
  const blocked = Array.isArray(r.blocked_domains) ? (r.blocked_domains as unknown[]) : [];
  const status = statusOf(block.result);

  const summary = <span className="truncate">&ldquo;{query}&rdquo;</span>;

  return (
    <ToolShell
      name="WebSearch"
      Icon={SearchCheck}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Query</FieldLabel>
            <div className="font-mono text-[11.5px] text-rose-200">{query}</div>
          </div>
          {(allowed.length > 0 || blocked.length > 0) && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {allowed.length > 0 && (
                <div>
                  <FieldLabel>Allowed domains</FieldLabel>
                  <div className="flex flex-wrap gap-1">
                    {allowed.map((d, i) => (
                      <span
                        key={`${i}-${String(d)}`}
                        className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10.5px] text-emerald-200"
                      >
                        {String(d)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {blocked.length > 0 && (
                <div>
                  <FieldLabel>Blocked domains</FieldLabel>
                  <div className="flex flex-wrap gap-1">
                    {blocked.map((d, i) => (
                      <span
                        key={`${i}-${String(d)}`}
                        className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-[10.5px] text-red-200"
                      >
                        {String(d)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Results'}</FieldLabel>
              <CodeBlock>{block.result.content || '(no results)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
