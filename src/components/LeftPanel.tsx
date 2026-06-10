'use client';

import TodoListPanel from './TodoListPanel';
import WorkspaceList from './WorkspaceList';

export default function LeftPanel() {
  return (
    <div className="flex h-full flex-col px-3 py-3">
      <div className="min-h-0 flex-1">
        <WorkspaceList />
      </div>
      <div className="mt-3 shrink-0">
        <TodoListPanel />
      </div>
    </div>
  );
}
