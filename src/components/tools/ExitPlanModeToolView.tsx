'use client';

import { ClipboardList } from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import Markdown from '../Markdown';
import { FieldLabel, ToolShell, asInputRecord, statusOf } from './ToolShell';

const tone = {
  stripe: 'bg-pink-400/70',
  icon: 'text-pink-400',
};

export function ExitPlanModeToolView({ block }: { block: ToolUseBlock }) {
  const r = asInputRecord(block.input);
  const plan = typeof r.plan === 'string' ? r.plan : '';
  const status = statusOf(block.result);
  const lineCount = plan ? plan.split('\n').length : 0;

  const summary = <span>Proposing plan ({lineCount} line{lineCount === 1 ? '' : 's'})</span>;

  return (
    <ToolShell
      name="ExitPlanMode"
      Icon={ClipboardList}
      tone={tone}
      summary={summary}
      status={status}
      defaultOpen
      body={
        <div className="space-y-2.5">
          <div>
            <FieldLabel>Plan</FieldLabel>
            <div className="rounded-md border border-pink-400/30 bg-pink-500/[0.05] p-2.5 text-[12.5px] leading-relaxed">
              <Markdown>{plan || '(empty)'}</Markdown>
            </div>
          </div>
        </div>
      }
    />
  );
}
