'use client';

import { Globe } from 'lucide-react';
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

export function WebFetchToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const url = typeof r.url === 'string' ? r.url : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt : '';
  const status = statusOf(block.result);

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }

  const summary = (
    <span className="flex items-center gap-2">
      <span className="truncate font-mono">{host}</span>
      {prompt && <span className="shrink-0 truncate text-muted-foreground/70">· {prompt}</span>}
    </span>
  );

  return (
    <ToolShell
      name="WebFetch"
      Icon={Globe}
      tone={tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>URL</FieldLabel>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="break-all font-mono text-[11.5px] text-rose-300 hover:underline"
            >
              {url}
            </a>
          </div>
          {prompt && (
            <div>
              <FieldLabel>Extraction prompt</FieldLabel>
              <div className="text-[11.5px] text-foreground/90">{prompt}</div>
            </div>
          )}
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error' : 'Response'}</FieldLabel>
              <CodeBlock>{block.result.content || '(empty)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
