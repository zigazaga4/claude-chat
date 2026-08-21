/**
 * The single front door. Every request that is not an explicitly listed
 * exception has to carry a valid session cookie to get past this file.
 *
 * Next 16 renamed `middleware` to `proxy`; the behaviour is unchanged, and it
 * runs on the Node.js runtime, so real `node:crypto` is available for the
 * signature check rather than the Web Crypto dance the Edge runtime forces.
 *
 * Deliberately not doing here:
 *   - No source-IP exemption. `tailscale serve` terminates TLS and forwards to
 *     127.0.0.1, so tailnet traffic and genuinely local traffic look identical
 *     at the socket. "Trust loopback" would exempt exactly the requests the
 *     gate is for.
 *   - No database or filesystem lookups per request. Session validity is a
 *     signature check over the cookie itself.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_REQUIRED_HEADER, SESSION_COOKIE, verifySession } from '@/server/auth';

export const config = {
  matcher: [
    /*
     * Everything except:
     *   _next/static, _next/image  — build output, no secrets, and gating it
     *                                 would break the login page's own CSS
     *   api/mcp/                   — called by the locally-spawned OpenCode
     *                                 child process, which holds no cookie and
     *                                 authenticates with a per-turn UUID in the
     *                                 path. Gating it silently strips the
     *                                 notebook/ssh/vision tools from every turn.
     *   icons + manifest           — fetched by the browser without credentials
     *                                 when installing the PWA
     */
    '/((?!_next/static|_next/image|api/mcp/|favicon\\.ico|manifest\\.webmanifest|icon-|apple-icon).*)',
  ],
};

/**
 * Headers applied to everything the gate lets through.
 *
 * These matter because the app is reachable from the open internet via
 * Tailscale Funnel. The framing controls are the important pair: without them
 * any page anywhere could load this app in an invisible iframe and trick a
 * logged-in browser into clicking things in it — and a click here can run a
 * shell command. `SameSite=Lax` on the session cookie blunts that but does not
 * cover it, because a framed same-site GET still carries the cookie.
 *
 * Deliberately not a full Content-Security-Policy: the app relies on inline
 * styles, and a half-correct CSP that breaks rendering is worse than a narrow
 * one that only does the job it is here for.
 */
function harden(res: NextResponse, isHttps: boolean): NextResponse {
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.headers.set('X-Content-Type-Options', 'nosniff');
  // Keeps the hostname out of the Referer sent to any third-party asset — the
  // URL is the one thing an attacker needs before the password even matters.
  res.headers.set('Referrer-Policy', 'no-referrer');
  if (isHttps) {
    // No includeSubDomains: this is a shared `*.ts.net` parent and the pin
    // would apply to unrelated hosts on the tailnet.
    res.headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return res;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isHttps =
    request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https' ||
    request.nextUrl.protocol === 'https:';

  // The login endpoints have to stay open or there is no way to ever get in.
  if (pathname.startsWith('/api/auth/')) return harden(NextResponse.next(), isHttps);

  const authed = verifySession(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === '/login') {
    // Already in — no reason to show the form again.
    return harden(
      authed ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next(),
      isHttps,
    );
  }

  if (authed) return harden(NextResponse.next(), isHttps);

  // An API caller wants a status code it can act on, not a login page. The
  // header is what tells the client this was "session gone" rather than a
  // route-level permission error, so it knows to bounce to /login.
  if (pathname.startsWith('/api/')) {
    return harden(
      NextResponse.json(
        { error: 'Not authenticated.' },
        { status: 401, headers: { [AUTH_REQUIRED_HEADER]: '1' } },
      ),
      isHttps,
    );
  }

  const login = new URL('/login', request.url);
  // Come back to whatever was being opened once the password lands.
  const from = pathname + request.nextUrl.search;
  if (from && from !== '/') login.searchParams.set('next', from);
  return harden(NextResponse.redirect(login), isHttps);
}
