'use client';

import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useInstances } from '@/state/instances';
import Logo from './Logo';

function basename(p: string | null) {
  if (!p) return null;
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || '/';
}

export default function InstanceTabs() {
  const { instances, activeId, setActive, addInstance, removeInstance } = useInstances();

  return (
    <div className="flex items-center gap-2 border-b border-border/70 bg-card/30 px-2.5 py-1.5 backdrop-blur-sm">
      <Logo />
      <div className="h-5 w-px bg-border/60" aria-hidden="true" />
      <div className="scrollbar-thin flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {instances.map((inst) => {
          const active = inst.id === activeId;
          const label = basename(inst.cwd) ?? inst.name;
          return (
            <div
              key={inst.id}
              role="button"
              tabIndex={0}
              onClick={() => setActive(inst.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActive(inst.id);
                }
              }}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-150',
                active
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
              title={inst.cwd ?? '(no folder selected)'}
            >
              <span className="max-w-[160px] truncate font-medium">{label}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeInstance(inst.id);
                }}
                className={cn(
                  'rounded p-0.5 transition-opacity',
                  active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
                  'hover:bg-foreground/10',
                )}
                aria-label="Close instance"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addInstance}
        className="ml-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="New instance"
        title="New instance"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
