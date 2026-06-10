'use client';

import { ChevronLeft, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ChatTab } from '@/lib/types';
import { useInstances } from '@/state/instances';
import ChatView from './ChatView';
import FilesView from './FilesView';
import ShellView from './ShellView';
import UsageMeter from './UsageMeter';

const TABS: { id: ChatTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'Files' },
];

export default function MainPane() {
  const { active, patch, backToPicker } = useInstances();
  const showBack = active.tab === 'chat' && active.view === 'conversation' && !!active.cwd;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/70 bg-card/20 px-3 py-1.5 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          {showBack ? (
            <button
              type="button"
              onClick={() => backToPicker(active.id)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-blue-400/30 bg-blue-500/[0.08] px-2.5 py-1 text-xs font-medium text-blue-300 transition-colors hover:border-blue-400/60 hover:bg-blue-500/15"
              title="Back to conversations"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <MessagesSquare className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Conversations</span>
            </button>
          ) : (
            <span aria-hidden="true" className="h-7" />
          )}
          <UsageMeter />
        </div>
        <nav className="flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => patch(active.id, { tab: t.id })}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                active.tab === t.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1">
        {active.tab === 'chat' ? (
          <ChatView />
        ) : active.tab === 'shell' ? (
          <ShellView />
        ) : (
          <FilesView />
        )}
      </div>
    </div>
  );
}
