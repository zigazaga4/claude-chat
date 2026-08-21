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
    /*
     * Walk backwards and stop at the first hit.
     *
     * The answer is by definition the LAST matching block, so scanning forward
     * from the beginning visited every block in the transcript and discarded
     * all but the final match. That cost lands in the hot path: `messages` is
     * a freshly built array on every streaming token, so this memo recomputes
     * per token — tens of thousands of block visits a second on a long
     * conversation, on the main thread, while the UI is trying to paint.
     *
     * Backwards, it almost always finishes within the newest message.
     */
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant') continue;
      for (let j = m.blocks.length - 1; j >= 0; j--) {
        const block = m.blocks[j];
        if (block.type === 'tool_use' && AUTO_OPEN_TOOLS.has(block.name)) {
          return block.id;
        }
      }
    }
    return undefined;
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
