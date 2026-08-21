/**
 * Auth constants that both sides of the wire need.
 *
 * Kept apart from `src/server/auth.ts` on purpose: that module imports
 * `node:crypto` and `node:fs`, and a client component importing a single
 * constant from it would drag the whole thing into the browser bundle.
 */

/** Marks a 401 as "your session is gone" rather than a route-level refusal. */
export const AUTH_REQUIRED_HEADER = 'x-auth-required';

export const SESSION_COOKIE = 'cc_session';
