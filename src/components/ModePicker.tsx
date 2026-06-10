'use client';

import { cn } from '@/lib/cn';
import type { PermissionMode } from '@/lib/types';

const ORDER: PermissionMode[] = ['default', 'auto', 'acceptEdits', 'bypassPermissions'];

const LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  auto: 'Auto',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass',
};

const STYLES: Record<PermissionMode, { btn: string; dot: string }> = {
  default: {
    btn: 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted',
    dot: 'bg-muted-foreground',
  },
  auto: {
    btn: 'border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/15',
    dot: 'bg-blue-500',
  },
  acceptEdits: {
    btn: 'border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500/15',
    dot: 'bg-green-500',
  },
  bypassPermissions: {
    btn: 'border-orange-500/40 bg-orange-500/10 text-orange-300 hover:bg-orange-500/15',
    dot: 'bg-orange-500',
  },
};

type ModePickerProps = {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
};

export default function ModePicker({ mode, onChange }: ModePickerProps) {
  const cycle = () => {
    const idx = ORDER.indexOf(mode);
    onChange(ORDER[(idx + 1) % ORDER.length]);
  };
  const s = STYLES[mode];

  return (
    <button
      type="button"
      onClick={cycle}
      title="Click to cycle permission mode (like Shift+Tab in Claude Code)"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
        s.btn,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      <span className="whitespace-nowrap">{LABELS[mode]}</span>
    </button>
  );
}
