'use client';

import LeftPanel from './LeftPanel';
import MainPane from './MainPane';
import InstanceTabs from './InstanceTabs';
import { InstancesProvider } from '@/state/instances';

export default function AppShell() {
  return (
    <InstancesProvider>
      <div className="flex h-full w-full flex-col bg-background">
        <InstanceTabs />
        <div className="flex min-h-0 flex-1">
          <aside
            className="hidden h-full w-60 shrink-0 border-r border-border/70 bg-card/40 backdrop-blur-sm md:block"
            aria-label="Left panel"
          >
            <LeftPanel />
          </aside>
          <main className="flex h-full min-w-0 flex-1 flex-col">
            <MainPane />
          </main>
        </div>
      </div>
    </InstancesProvider>
  );
}
