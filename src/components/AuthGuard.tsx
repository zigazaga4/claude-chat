'use client';

import { useEffect } from 'react';
import { AUTH_REQUIRED_HEADER } from '@/lib/authShared';

/**
 * Sends the tab to /login the moment the server says the session is gone.
 *
 * The alternative was a check at each of the ~37 `fetch('/api/…')` call sites.
 * Wrapping `window.fetch` once covers all of them, including the ones added
 * later, and leaves every existing caller untouched.
 *
 * The wrapper is transparent: it awaits nothing on the body and returns the
 * original `Response` object, so the NDJSON chat stream and the SSE shell
 * stream keep streaming rather than being buffered here.
 */

// Module scope, not component state: React 19 strict mode mounts effects twice
// in development and this must not stack two wrappers.
let installed = false;

export default function AuthGuard() {
  useEffect(() => {
    if (installed) return;
    installed = true;

    const original = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args);
      if (res.status === 401 && res.headers.get(AUTH_REQUIRED_HEADER) === '1') {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.replace(`/login?next=${next}`);
      }
      return res;
    };
  }, []);

  return null;
}
