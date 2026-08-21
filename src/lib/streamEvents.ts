/**
 * The NDJSON event contract between `/api/chat` and the client.
 *
 * This is deliberately backend-agnostic. Two very different harnesses produce
 * these events today — the Claude Agent SDK (which spawns the Claude Code CLI)
 * and OpenCode (which runs as its own HTTP server) — and the client cannot tell
 * them apart. Keeping the union here, rather than inside the route, is what
 * makes that possible: both runners import the same type and are type-checked
 * against the same vocabulary, so a new backend can never silently invent an
 * event the UI does not handle.
 *
 * Names and payloads mirror the Anthropic streaming shape because that is what
 * the client was built against; a backend whose native events differ is
 * responsible for translating into this vocabulary, not the other way around.
 */

import type { ImageAttachmentBlock } from './types';

export type StreamEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'stream_ready';
      /** Echo of the first assistantMessageId — clients use it as the inject key. */
      streamId: string;
    }
  | {
      type: 'turn_started';
      /** Index of this turn within the stream — first turn is 0. */
      turnIndex: number;
      userMessageId: string;
      assistantMessageId: string;
      prompt: string;
      images?: ImageAttachmentBlock[];
    }
  | { type: 'text_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'text_stop' }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_stop' }
  | { type: 'tool_use_start'; toolUseId: string; name: string }
  | { type: 'tool_use_input'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'awaiting_question'; toolUseId: string; input: unknown }
  | {
      type: 'question_answered';
      toolUseId: string;
      answers: Record<string, string>;
    }
  | {
      type: 'token_budget';
      used: number;
      total: number;
      /**
       * How that footprint splits by billing category, when the provider says.
       * The gauge only needs the total, but credit-billed models price these
       * three at rates an order of magnitude apart — cached input is 10x
       * cheaper than fresh, output 6x dearer — so the split is what makes a
       * cost estimate possible. Optional: providers that report only a total
       * still drive the gauge exactly as before.
       */
      split?: { input: number; cached: number; output: number };
    }
  | {
      /**
       * The SDK registered a task.
       *
       * This does NOT mean "something is running in the background". The CLI
       * registers a task for *any* Bash command still going after ~2s, purely
       * so it can offer Ctrl+B to background it — the command is still a
       * blocking, foreground part of the turn. Foreground `Agent` calls
       * register at spawn too. Treating this event as "background task" is why
       * an ordinary `npm run build` showed up in the running-tasks strip.
       *
       * `isBackgrounded` is the field to branch on. `taskType` is the SDK's raw
       * discriminant (`local_bash`, `local_agent`, `local_workflow`, …).
       */
      type: 'task_started';
      taskId: string;
      description: string;
      subagentType?: string | null;
      taskType?: string | null;
      /** The tool call this task belongs to, when the SDK reports one. */
      toolUseId?: string | null;
      /** True only for work that genuinely outlives the turn. */
      isBackgrounded?: boolean;
    }
  | {
      /** Periodic progress ping for a running background task. */
      type: 'task_progress';
      taskId: string;
      description: string;
      lastToolName?: string | null;
    }
  | {
      /**
       * A task changed state. The only part we care about is the moment a
       * foreground command is promoted to the background (Ctrl+B, or the SDK
       * auto-backgrounding it) — this is the sole authoritative background
       * signal on the stream, and it arrives nowhere else.
       */
      type: 'task_updated';
      taskId: string;
      isBackgrounded?: boolean;
      status?: string | null;
    }
  | {
      /** A task settled (completed / failed / stopped). */
      type: 'task_finished';
      taskId: string;
      status: string;
      summary: string;
    }
  | {
      type: 'compact_boundary';
      messageId: string;
      trigger: 'manual' | 'auto';
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
    }
  | {
      /** Safety-classifier decline — HTTP 200 with stop_reason "refusal", not an error. */
      type: 'refusal';
      model: string;
      category?: string | null;
      explanation?: string | null;
    }
  | {
      /** Account-level subscription usage from the SDK's rate_limit_event. */
      type: 'rate_limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      utilization?: number;
      rateLimitType?: string;
      resetsAt?: number;
      isUsingOverage?: boolean;
    }
  | {
      /**
       * Structured /usage data (the SDK control request behind Claude Code's
       * /usage command): per-window utilization percentages, fetched after
       * every function-calling loop. resetsAt values are epoch ms.
       */
      type: 'usage';
      fiveHour?: { utilization: number | null; resetsAt: number | null } | null;
      sevenDay?: { utilization: number | null; resetsAt: number | null } | null;
      sevenDayOpus?: { utilization: number | null; resetsAt: number | null } | null;
      sevenDaySonnet?: { utilization: number | null; resetsAt: number | null } | null;
      extraUsage?: {
        isEnabled: boolean;
        utilization: number | null;
        usedCredits: number | null;
        monthlyLimit: number | null;
      } | null;
    }
  | { type: 'message_complete'; assistantMessageId: string }
  | { type: 'complete' }
  | { type: 'error'; error: string };

const NDJSON_ENCODER = new TextEncoder();

export function encodeNDJSON(event: StreamEvent): Uint8Array {
  return NDJSON_ENCODER.encode(`${JSON.stringify(event)}\n`);
}
