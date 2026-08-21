/**
 * Which subagents are currently in flight, per conversation.
 *
 * A model can see the `Agent` calls it makes itself and nothing else — not its
 * siblings, not agents left running by an earlier turn, and not a total. That
 * blind spot is how a session reached 30 concurrent agents while every
 * individual decision along the way looked reasonable.
 *
 * The chat route already tracks live tasks per stream, but that set holds only
 * ids and dies when the stream closes. This registry keeps the descriptions and
 * start times, and outlives a single turn, so the next turn's system prompt can
 * tell the model what is still running before it decides to dispatch more.
 *
 * In-memory on purpose: subagents live inside the CLI process, so anything
 * still listed here is meaningless once that process exits. `clearConversation`
 * is called at stream teardown for exactly that reason.
 */

export type LiveAgent = {
  id: string;
  description: string;
  agentType: string | null;
  startedAt: number;
};

const byConversation = new Map<string, Map<string, LiveAgent>>();

export function agentStarted(conversationId: string | null, agent: LiveAgent): void {
  if (!conversationId) return;
  let live = byConversation.get(conversationId);
  if (!live) {
    live = new Map();
    byConversation.set(conversationId, live);
  }
  live.set(agent.id, agent);
}

export function agentFinished(conversationId: string | null, agentId: string): void {
  if (!conversationId) return;
  const live = byConversation.get(conversationId);
  if (!live) return;
  live.delete(agentId);
  if (live.size === 0) byConversation.delete(conversationId);
}

/** Drop everything for a conversation — its CLI process is gone. */
export function clearConversation(conversationId: string | null): void {
  if (!conversationId) return;
  byConversation.delete(conversationId);
}

export function listLiveAgents(conversationId: string | null): LiveAgent[] {
  if (!conversationId) return [];
  const live = byConversation.get(conversationId);
  if (!live) return [];
  return [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** `4m` / `35s` — how long an agent has been running, for the prompt. */
function forHumans(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/**
 * The live-agent section of the system prompt, or '' when nothing is running.
 * `now` is passed in rather than read here so the caller controls the clock.
 */
export function describeLiveAgents(conversationId: string | null, now: number): string {
  const live = listLiveAgents(conversationId);
  if (live.length === 0) return '';
  const lines = live.map((a) => {
    const type = a.agentType ? `[${a.agentType}] ` : '';
    const desc = a.description.trim() || '(no description)';
    return `- ${type}${desc} — running ${forHumans(now - a.startedAt)}`;
  });
  return (
    `**${live.length} subagent${live.length === 1 ? '' : 's'} still running from an ` +
    `earlier turn.** Count ${live.length === 1 ? 'it' : 'them'} against anything you ` +
    `dispatch now, and check whether what you are about to start is already covered:\n` +
    lines.join('\n')
  );
}
