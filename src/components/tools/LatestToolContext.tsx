'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ChatMessage } from '@/lib/types';

/**
 * Tool names whose most recent block is auto-expanded. Both local and
 * SSH (mcp__remote__*) variants share one slot — only the single
 * most-recent edit/write across the whole conversation stays open.
 */
const AUTO_OPEN_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'mcp__remote__write',
  'mcp__remote__edit',
]);

const LatestAutoOpenContext = createContext<string | undefined>(undefined);

export function LatestToolProvider({
  messages,
  children,
}: {
  messages: ChatMessage[];
  children: ReactNode;
}) {
  const latestId = useMemo<string | undefined>(() => {
    let latest: string | undefined;
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const block of m.blocks) {
        if (block.type !== 'tool_use') continue;
        if (!AUTO_OPEN_TOOLS.has(block.name)) continue;
        latest = block.id;
      }
    }
    return latest;
  }, [messages]);

  return (
    <LatestAutoOpenContext.Provider value={latestId}>
      {children}
    </LatestAutoOpenContext.Provider>
  );
}

/** True only for the single most-recent edit/write block in the chat. */
export function useIsLatestAutoOpen(blockId: string): boolean {
  return useContext(LatestAutoOpenContext) === blockId;
}
