/**
 * Client-side calls against `/api/conversations/[id]`.
 *
 * Both are used by the throwaway-chat flow: one to delete a conversation the
 * user is done with, one to promote it into a saved conversation instead.
 * They're deliberately best-effort — a throwaway that survives a failed
 * request is swept server-side, so a dropped network call is never fatal.
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
