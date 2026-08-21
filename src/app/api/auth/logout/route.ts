import { NextResponse } from 'next/server';
import { SESSION_COOKIE, requestIsHttps, sessionCookieOptions } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const res = NextResponse.json({ ok: true });
  // Overwrite rather than delete, with the same attributes it was set with —
  // a `Set-Cookie` whose path or secure flag differs is simply ignored by the
  // browser and the session would survive the logout.
  res.cookies.set(SESSION_COOKIE, '', {
    ...sessionCookieOptions(requestIsHttps(req.headers, req.url)),
    maxAge: 0,
  });
  return res;
}
