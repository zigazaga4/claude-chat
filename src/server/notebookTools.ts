/**
 * SDK MCP server exposing a single `notebook` tool — the model's private,
 * per-conversation scratchpad. Storage is injected as read/write closures so
 * the tool is always available: the caller routes reads/writes to the DB once
 * the conversation id is known, or to an in-memory buffer before that (flushed
 * to the DB the moment the SDK emits the session id).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  applyEdit,
  lineCount,
  numbered,
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
  /**
   * Read the current notebook text. The caller decides where it comes from —
   * the DB once the conversation id is known, or an in-memory buffer before
   * that — so the tool is ALWAYS available, even on the very first turn.
   */
  read: () => string;
  /** Persist the new notebook text (DB or buffer, caller's choice). */
  write: (content: string) => void;
};

const DESCRIPTION = `Your private, per-conversation notebook. Its contents are injected into your system prompt every turn, so anything written here stays available to you later in this conversation even after the surrounding messages drop out of context.

Use it on your own initiative to record durable KNOWLEDGE worth keeping — established facts, specifics you discovered and would otherwise have to re-derive, hard constraints and rules you must honor, the user's stated preferences and conventions, key decisions, and important details about the system you are working on. Anything the user tells you to remember is a mandatory write.

Record knowledge, not work. This is NOT a to-do list, a task tracker, a plan, or a running log — never put tasks, steps, checklists, "next I will…", or progress updates here. Only durable facts and constraints that stay useful later belong in the notebook.

Keep it lean. It is a small, living reference, not an append-only dump: add a note only when it has lasting value, keep each line short and self-contained, and actively delete or rewrite entries the moment they go stale, get resolved, or stop being relevant. A short, current notebook is the goal — prune aggressively, and do not store secrets you do not need.

The notebook is line-numbered. Before any edit that targets existing lines (replace, insert, delete) call \`view\` first, because line numbers shift after every edit. These notes are visible only to you and only in this conversation.`;

export function createNotebookMcpServer(ctx: NotebookToolContext) {
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
          const current = ctx.read();

          if (args.action === 'view') {
            return ok(`Notebook (${lineCount(current)} line(s)):\n${numbered(current)}`);
          }

          const res = applyEdit(current, args.action as NotebookEditAction, {
            text: args.text,
            start: args.start,
            end: args.end,
          });
          if (!res.ok) return err(res.error);

          ctx.write(res.content);
          return show(res.content, res.summary);
        },
      ),
    ],
  });
}
