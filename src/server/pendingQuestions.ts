/**
 * Server-side rendezvous between the streaming /api/chat route and the
 * /api/chat/answer endpoint. When the model invokes the AskUserQuestion tool,
 * the chat route's canUseTool callback registers a pending entry here and
 * awaits the answers; the answer endpoint resolves it once the user replies.
 *
 * Stored on globalThis so dev-mode module reloads don't drop in-flight entries.
 */

export type Answers = Record<string, string>;

type Entry = {
  resolve: (answers: Answers) => void;
  reject: (err: Error) => void;
};

type Store = Map<string, Entry>;

const KEY = '__cc_pendingQuestions__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) g[KEY] = new Map<string, Entry>();
const store = g[KEY] as Store;

/**
 * Register a pending question and return a Promise that resolves once
 * the user submits answers (or rejects if cancelled / aborted).
 */
export function awaitAnswers(toolUseId: string, signal: AbortSignal): Promise<Answers> {
  return new Promise<Answers>((resolve, reject) => {
    const onAbort = () => {
      store.delete(toolUseId);
      reject(new Error('aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    store.set(toolUseId, {
      resolve: (a) => {
        signal.removeEventListener('abort', onAbort);
        resolve(a);
      },
      reject: (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    });
  });
}

/** Resolve the pending question. Returns true if there was one to resolve. */
export function submitAnswers(toolUseId: string, answers: Answers): boolean {
  const entry = store.get(toolUseId);
  if (!entry) return false;
  store.delete(toolUseId);
  entry.resolve(answers);
  return true;
}

/** Cancel a pending question (e.g. user dismissed). */
export function cancelQuestion(toolUseId: string, message = 'cancelled'): boolean {
  const entry = store.get(toolUseId);
  if (!entry) return false;
  store.delete(toolUseId);
  entry.reject(new Error(message));
  return true;
}
