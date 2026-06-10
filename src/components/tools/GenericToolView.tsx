'use client';

import { Wrench } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import { CodeBlock, FieldLabel, ToolShell, statusOf } from './ToolShell';

const tone = {
  stripe: 'bg-zinc-400/70',
  icon: 'text-zinc-300',
};

const mcpTone = {
  stripe: 'bg-teal-400/70',
  icon: 'text-teal-300',
};

function summarizeInput(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const r = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    if (typeof r[key] === 'string') return String(r[key]);
  }
  return null;
}

function formatInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function GenericToolView({ block }: { block: ToolUseBlock }) {
  const status = statusOf(block.result);
  const isMcp = block.name.startsWith('mcp__');
  const displayName = isMcp ? block.name.replace(/^mcp__/, '').replace(/__/g, ' · ') : block.name;
  const summary = summarizeInput(block.input);

  return (
    <ToolShell
      name={isMcp ? `mcp · ${displayName}` : block.name}
      Icon={Wrench}
      tone={isMcp ? mcpTone : tone}
      summary={summary}
      status={status}
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Input</FieldLabel>
            <CodeBlock>{formatInput(block.input) || '(no input)'}</CodeBlock>
          </div>
          {block.result && (
            <div>
              <FieldLabel>{block.result.isError ? 'Error output' : 'Output'}</FieldLabel>
              <CodeBlock>{block.result.content || '(empty)'}</CodeBlock>
            </div>
          )}
        </div>
      }
    />
  );
}
