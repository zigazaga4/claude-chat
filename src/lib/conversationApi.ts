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
 */

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
