'use client';

import { useCallback, useRef } from 'react';
import { isValidEffort, type EffortSuggestion } from '@/lib/models';

/**
 * Client side of the "auto effort" feature. `suggest(prompt)` asks the server
 * classifier (Sonnet 4.6) which thinking effort the request warrants and
 * returns its recommendation, or `null` when no usable suggestion came back
 * (bad/empty response, network error, or an aborted in-flight request) — in
 * which case the caller should just send with the user's current effort.
 *
 * Only one suggestion is ever in flight: a new `suggest()` call aborts the
 * previous one, so a fast second Enter can't leave a stale recommendation
 * racing behind the live request.
 */
export function useEffortSuggestion() {
  const acRef = useRef<AbortController | null>(null);

  const suggest = useCallback(
    async (prompt: string): Promise<EffortSuggestion | null> => {
      const trimmed = prompt.trim();
      if (!trimmed) return null;
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      try {
        const res = await fetch('/api/suggest-effort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: trimmed }),
          signal: ac.signal,
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { effort?: unknown; reason?: unknown };
        if (typeof data.effort !== 'string' || !isValidEffort(data.effort)) {
          return null;
        }
        return {
          effort: data.effort,
          reason: typeof data.reason === 'string' ? data.reason : '',
        };
      } catch {
        return null;
      } finally {
        if (acRef.current === ac) acRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    acRef.current?.abort();
    acRef.current = null;
  }, []);

  return { suggest, cancel };
}
