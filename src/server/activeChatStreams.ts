/**
 * Per-process registry of in-flight `/api/chat` streams.
 *
 * A single `/api/chat` POST stays open across multiple user turns: it keeps an
 * SDK `query()` alive on an AsyncIterable input, pumps NDJSON to the client,
 * and finishes only once the model is idle and nothing new has been queued.
 *
 * When the user types another message while a turn is still in flight, the
 * `/api/chat/inject` endpoint looks the active stream up here and pushes the
 * new message onto the running query's input — that's how mid-loop injection
 * works without a second HTTP request fighting for the same session.
 *
 * Stored on `globalThis` so dev-mode hot reloads don't drop entries.
 */
import type { ImageAttachmentBlock, ImageMediaType } from '@/lib/types';

export type InjectImage = {
  dataUrl: string;
  mediaType: ImageMediaType;
  name?: string;
};

export type InjectRequest = {
  /** Caller-allocated id so the eventual UserMessage matches across UI + DB. */
  userMessageId: string;
  /** Caller-allocated id for the assistant turn that the model will produce in response. */
  assistantMessageId: string;
  prompt: string;
  images?: InjectImage[];
  /** Persisted UI image blocks, mirroring what the first turn stores. */
  userImages?: ImageAttachmentBlock[];
};

export type InjectResult =
  | { ok: true }
  /** No active stream (it finished or was aborted) — caller should fall back to a fresh POST /api/chat. */
  | { ok: false; reason: 'no-active-stream' }
  /** Stream is alive but already past the point where it accepts new input. */
  | { ok: false; reason: 'stream-closing' };

type Entry = {
  push: (req: InjectRequest) => InjectResult;
};

type Store = Map<string, Entry>;

const KEY = '__cc_activeChatStreams__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) g[KEY] = new Map<string, Entry>();
const store = g[KEY] as Store;

export function registerActiveStream(
  streamId: string,
  entry: Entry,
): () => void {
  store.set(streamId, entry);
  return () => {
    const current = store.get(streamId);
    if (current === entry) store.delete(streamId);
  };
}

export function injectIntoStream(
  streamId: string,
  req: InjectRequest,
): InjectResult {
  const entry = store.get(streamId);
  if (!entry) return { ok: false, reason: 'no-active-stream' };
  return entry.push(req);
}
