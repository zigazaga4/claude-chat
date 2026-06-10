'use client';

import { ShieldAlert } from 'lucide-react';
import type { RefusalBlock } from '@/lib/types';
import { MODELS } from '@/lib/models';

/** Human-readable names for the documented classifier categories. */
const CATEGORY_LABELS: Record<string, string> = {
  cyber: 'Cyber safety classifier',
  bio: 'Biology safety classifier',
  reasoning_extraction: 'Reasoning-extraction classifier',
};

function modelLabel(id: string | undefined): string {
  if (!id) return 'The model';
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/**
 * Dedicated UI for a safety-classifier refusal (Claude Fable 5 / Mythos-class
 * models). Deliberately distinct from the red error block: a refusal is a
 * successful API response where the model DECLINED — the request didn't fail,
 * and retrying the same model usually earns another refusal. The hint points
 * at the model picker instead.
 */
export default function RefusalBlockView({ block }: { block: RefusalBlock }) {
  const categoryLabel = block.category
    ? (CATEGORY_LABELS[block.category] ?? block.category)
    : null;
  return (
    <div className="max-w-full rounded-2xl border border-orange-400/40 bg-orange-500/[0.08] px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-orange-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-orange-200">
              {modelLabel(block.model)} declined this request
            </span>
            {categoryLabel && (
              <span className="rounded-full border border-orange-400/40 bg-orange-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-200/90">
                {categoryLabel}
              </span>
            )}
          </div>
          {block.explanation && (
            <p className="mt-1 text-[13px] leading-snug text-orange-100/80">
              {block.explanation}
            </p>
          )}
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            This is a safety-classifier refusal, not an error. Retrying the
            same model will usually decline again — switching to another model
            in the picker normally serves the request.
          </p>
        </div>
      </div>
    </div>
  );
}
