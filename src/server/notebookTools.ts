/**
 * SDK MCP server exposing a single `notebook` tool — the model's private,
 * per-conversation scratchpad. Bound to the live conversation via a getter
 * (the session id isn't known until the SDK emits it), so writes always land
 * on the conversation the model is actually in.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  applyEdit,
  lineCount,
  numbered,
  readNotebook,
  writeNotebook,
  type NotebookEditAction,
} from './notebook';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function show(content: string, prefix: string): ToolResult {
  return ok(`${prefix} — notebook now (${lineCount(content)} line(s)):\n${numbered(content)}`);
}

export type NotebookToolContext = {
  /** Resolves the active conversation id at call time (null before session start). */
  getConversationId: () => string | null;
  /** Monotonic-ish timestamp source (kept injectable for testing). */
  now?: () => number;
};

const DESCRIPTION = `Your private, per-conversation notebook. Its contents are injected into your system prompt every turn, so anything written here stays available to you later in this conversation even after the surrounding messages drop out of context.

Use it on your own initiative, without being asked, to record durable things you will need again later and would otherwise forget: facts, constraints, decisions already made, the user's stated preferences and conventions, the current state of what you are working on, and conclusions you have reached. Anything the user tells you to remember is a mandatory write.

Keep it accurate and current — it is a living document, not an append-only log: when a note becomes outdated or wrong, modify or delete it instead of leaving it. Keep each line short and self-contained. Do not store secrets you do not need or transient chatter.

The notebook is line-numbered. Before any edit that targets existing lines (replace, insert, delete) call \`view\` first, because line numbers shift after every edit. These notes are visible only to you and only in this conversation.`;

export function createNotebookMcpServer(ctx: NotebookToolContext) {
  const now = ctx.now ?? (() => Date.now());
  return createSdkMcpServer({
    name: 'notebook',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'notebook',
        DESCRIPTION,
        {
          action: z
            .enum(['view', 'append', 'insert', 'replace', 'delete'])
            .describe(
              'view: show the notebook with line numbers. append: add text as new line(s) at the end. insert: add text after line `start` (0 = top). replace: overwrite lines `start`..`end` with text. delete: remove lines `start`..`end`.',
            ),
          text: z
            .string()
            .optional()
            .describe(
              'Note content for append/insert/replace. May span multiple lines. Ignored by view/delete.',
            ),
          start: z
            .number()
            .int()
            .optional()
            .describe(
              '1-based first line for replace/insert/delete (for insert, 0 means the top). Required for those actions.',
            ),
          end: z
            .number()
            .int()
            .optional()
            .describe('1-based last line (inclusive) for replace/delete. Defaults to `start`.'),
        },
        async (args): Promise<ToolResult> => {
          const id = ctx.getConversationId();
          if (!id) {
            return err('Notebook is not available yet — no active conversation. Try again after the first response.');
          }
          const current = readNotebook(id);

          if (args.action === 'view') {
            return ok(`Notebook (${lineCount(current)} line(s)):\n${numbered(current)}`);
          }

          const res = applyEdit(current, args.action as NotebookEditAction, {
            text: args.text,
            start: args.start,
            end: args.end,
          });
          if (!res.ok) return err(res.error);

          writeNotebook(id, res.content, now());
          return show(res.content, res.summary);
        },
      ),
    ],
  });
}
