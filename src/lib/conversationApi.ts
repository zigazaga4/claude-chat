/**
 * Client-side calls against `/api/conversations/[id]`.
 *
 * The first two belong to the throwaway-chat flow: one deletes a conversation
 * the user is done with, one promotes it into a saved conversation instead.
 * Those are deliberately best-effort — a throwaway that survives a failed
 * request is swept server-side, so a dropped network call is never fatal.
 *
 * `moveConversation` is the opposite and throws on failure. It is a deliberate
 * action with a visible result, and a move that silently did not happen would
 * leave the user looking at a folder wondering where the conversation went.
 * `forkConversation` ("Rewind to here") throws for the same reason.
 */

import type { ChatBackend } from './backends';

/** Delete a conversation and its transcript. Resolves even on failure. */
export async function discardConversation(id: string): Promise<void> {
  try {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* best effort — the server sweep is the backstop */
  }
}

/** Promote a throwaway conversation into a normal, listed one. */
export async function keepConversation(id: string): Promise<void> {
  try {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep: true }),
    });
  } catch {
    /* best effort */
  }
}

export type MoveResult = {
  from: string;
  to: string;
  /** Whether the CLI transcript had to be relocated on disk to follow it. */
  transcriptMoved: boolean;
};

/**
 * Move a conversation into another workspace. Throws with the server's own
 * message on failure, which is already written to be shown to a person.
 *
 * `fromCwd` is the folder the caller listed it under. It only matters for a
 * session the Claude CLI wrote that this app has never stored — the server
 * needs to be told where to find its transcript before it can adopt it.
 */
export async function moveConversation(
  id: string,
  toCwd: string,
  fromCwd?: string,
): Promise<MoveResult> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: toCwd, from: fromCwd }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  } & Partial<MoveResult>;
  if (!res.ok || !data.ok) {
    throw new Error(data.error ?? 'The conversation could not be moved.');
  }
  return {
    from: data.from ?? '',
    to: data.to ?? toCwd,
    transcriptMoved: data.transcriptMoved ?? false,
  };
}

export type ForkResult = {
  /**
   * The new conversation, or null when the rewound message was the first one —
   * there is nothing to copy, so the caller starts a fresh conversation in
   * `cwd` with `prefill` in the composer instead.
   */
  conversationId: string | null;
  cwd: string;
  backend: ChatBackend;
  /** Set when rewinding to a user message: its text, to edit and resend. */
  prefill?: string;
};

/**
 * "Rewind to here": copy the conversation up to `messageId` into a new one.
 * The original is never modified. Throws with the server's own message.
 */
export async function forkConversation(id: string, messageId: string): Promise<ForkResult> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  } & Partial<ForkResult>;
  if (!res.ok || !data.ok || typeof data.cwd !== 'string') {
    throw new Error(data.error ?? 'The conversation could not be rewound.');
  }
  return {
    conversationId: data.conversationId ?? null,
    cwd: data.cwd,
    backend: data.backend ?? 'sdk',
    prefill: typeof data.prefill === 'string' ? data.prefill : undefined,
  };
}

/**
 * Window event fired after something outside the sidebar added a conversation
 * to a folder (a rewind), so the sidebar can re-read that folder's list.
 */
export const CONVERSATIONS_CHANGED_EVENT = 'claude-chat:conversations-changed';

export function notifyConversationsChanged(cwd: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ cwd: string }>(CONVERSATIONS_CHANGED_EVENT, { detail: { cwd } }));
}
