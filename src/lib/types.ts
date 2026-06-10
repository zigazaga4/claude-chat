export type PermissionMode = 'default' | 'auto' | 'acceptEdits' | 'bypassPermissions';

export type ChatTab = 'chat' | 'shell' | 'files';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type TextBlock = {
  type: 'text';
  id: string;
  text: string;
  streaming?: boolean;
};

export type ThinkingBlock = {
  type: 'thinking';
  id: string;
  text: string;
  streaming?: boolean;
};

export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  toolUseId: string;
  name: string;
  input: unknown;
  result?: { content: string; isError: boolean };
  /** AskUserQuestion: answers chosen by the user, keyed by question text. */
  answers?: Record<string, string>;
  /**
   * True between content_block_start (we know the tool name) and the full
   * input arriving via the assistant message. Lets the UI show a loading
   * placeholder for big Edit / Write calls instead of waiting silently.
   */
  streaming?: boolean;
};

export type AskUserQuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type AskUserQuestionItem = {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type PendingQuestion = {
  toolUseId: string;
  questions: AskUserQuestionItem[];
};

export type ErrorBlock = {
  type: 'error';
  id: string;
  text: string;
};

/**
 * A safety-classifier refusal (Claude Fable 5 / Mythos-class models). The API
 * returns this as a SUCCESSFUL response with `stop_reason: "refusal"` — it is
 * not an error — so it gets its own block type and its own UI treatment,
 * distinct from ErrorBlock. `category` names the policy area ("cyber", "bio",
 * "reasoning_extraction", …); `explanation` is unstable human prose — display
 * it, never parse it. Both can be null/absent per the API contract.
 */
export type RefusalBlock = {
  type: 'refusal';
  id: string;
  /** Model that declined (e.g. "claude-fable-5"). */
  model?: string;
  category?: string | null;
  explanation?: string | null;
};

/**
 * Account-level subscription usage reported by the SDK's rate_limit_event.
 * `utilization` is a percentage (0–100) of the current window already used.
 */
export type RateLimitUsage = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  utilization?: number;
  rateLimitType?: string;
  /** Epoch ms when the current usage window resets. */
  resetsAt?: number;
  isUsingOverage?: boolean;
  /** Epoch ms when this snapshot was received — staleness indicator. */
  receivedAt: number;
};

/** One plan rate-limit window from the SDK's /usage data. */
export type PlanUsageWindow = {
  /** Percentage of the window used, 0–100. Null when the endpoint omits it. */
  utilization: number | null;
  /** Epoch ms when the window resets, or null when unknown. */
  resetsAt: number | null;
};

/**
 * Structured /usage data (the same numbers Claude Code's /usage command
 * shows): claude.ai plan rate-limit utilization per window, fetched from the
 * SDK after every function-calling loop. Null windows mean the plan doesn't
 * expose that window.
 */
export type PlanUsage = {
  fiveHour?: PlanUsageWindow | null;
  sevenDay?: PlanUsageWindow | null;
  sevenDayOpus?: PlanUsageWindow | null;
  sevenDaySonnet?: PlanUsageWindow | null;
  extraUsage?: {
    isEnabled: boolean;
    utilization: number | null;
    usedCredits: number | null;
    monthlyLimit: number | null;
  } | null;
  /** Epoch ms when this snapshot was received — staleness indicator. */
  receivedAt: number;
};

export type ImageAttachmentBlock = {
  type: 'image';
  id: string;
  /** Stored as a `data:` URI for inline display + persistence. */
  dataUrl: string;
  mediaType: ImageMediaType;
  name?: string;
};

export type CompactBoundaryBlock = {
  type: 'compact_boundary';
  id: string;
  trigger: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ErrorBlock
  | RefusalBlock
  | ImageAttachmentBlock
  | CompactBoundaryBlock;

export type UserMessage = {
  id: string;
  role: 'user';
  text: string;
  images?: ImageAttachmentBlock[];
  createdAt: number;
};

export type AssistantMessage = {
  id: string;
  role: 'assistant';
  blocks: ContentBlock[];
  createdAt: number;
  streaming?: boolean;
};

export type SystemMessage = {
  id: string;
  role: 'system';
  blocks: ContentBlock[];
  createdAt: number;
};

export type ChatMessage = UserMessage | AssistantMessage | SystemMessage;

/**
 * A user message typed while the agent was busy. Held in instance state
 * until the server acknowledges it (mid-loop inject → `turn_started`), at
 * which point it's promoted into the real chat history. If the inject fails
 * because the stream just closed, the streaming hook drains the queue by
 * opening a fresh `/api/chat` POST with the same ids — so the message
 * keeps its identity end-to-end.
 *
 * `userMessageId` / `assistantMessageId` are allocated at enqueue time so
 * we can match the eventual `turn_started` event back to this queue entry
 * regardless of how it ends up being delivered.
 */
export type QueuedMessage = {
  id: string;
  userMessageId: string;
  assistantMessageId: string;
  text: string;
  images?: {
    id: string;
    dataUrl: string;
    mediaType: ImageMediaType;
    name?: string;
  }[];
  createdAt: number;
};
