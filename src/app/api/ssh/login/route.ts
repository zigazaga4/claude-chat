import type { NextRequest } from 'next/server';
import { parseCwd } from '@/lib/cwd';
import { disconnectHost, getHost, type ConnectOpts } from '@/server/sshHosts';
import {
  clearStoredSshPassword,
  getStoredSshPassword,
  getWorkspace,
  upsertSshWorkspace,
} from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  cwd?: string;
  password?: string;
  rememberPassword?: boolean;
  /** Optional override for the identity file path. */
  identityPath?: string | null;
  /** Optional override for the SSH-agent toggle. */
  useAgent?: boolean;
  /**
   * Explicitly skip the stored password and clear it. Use this when the user
   * wants to switch a host to key/agent auth.
   */
  forgetPassword?: boolean;
  /**
   * "Just connect like `ssh` would" — ignore every saved auth detail, clear
   * any stored password, and let the server auto-discover SSH_AUTH_SOCK +
   * default keys in ~/.ssh. Used by the "Try connecting" button.
   */
  tryAuto?: boolean;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.cwd) return Response.json({ error: 'cwd required' }, { status: 400 });

  let parsed;
  try {
    parsed = parseCwd(body.cwd);
  } catch {
    return Response.json({ error: 'invalid cwd' }, { status: 400 });
  }
  if (parsed.kind !== 'ssh') {
    return Response.json({ error: 'cwd is not SSH' }, { status: 400 });
  }

  const ws = getWorkspace(body.cwd);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });

  // "Try connecting" path: discard every saved auth knob and let the server
  // auto-discover the same way the system `ssh` command does. We also drop
  // the pinned host fingerprint — common reasons it diverges (VPS rebuild,
  // OS reinstall, OpenSSH key rotation) all leave the user stuck even when
  // their terminal `ssh` happily reconnects. We capture the new fingerprint
  // on success and save it, so the next attempt picks up the fresh pin.
  const tryAuto = !!body.tryAuto;
  if (tryAuto) {
    clearStoredSshPassword(body.cwd);
  }

  // Allow callers to override the saved identity / agent toggle for this login
  // attempt. The values are persisted on success so subsequent reconnects use
  // them too. tryAuto blanks both so auto-discovery is what actually runs.
  const identityPath = tryAuto
    ? null
    : body.identityPath !== undefined
      ? normalizePath(body.identityPath)
      : ws.sshIdentityPath;
  const useAgent = tryAuto
    ? false
    : body.useAgent !== undefined
      ? !!body.useAgent
      : ws.sshUseAgent;

  // Forgetting the password is immediate, regardless of whether the connection
  // succeeds — that's what the user asked for. Clear it first so we never
  // fall back to a stale credential during this attempt.
  if (body.forgetPassword) {
    clearStoredSshPassword(body.cwd);
  }

  // Pick a password: explicit > stored (if not forgotten / auto) > none.
  const stored =
    body.forgetPassword || tryAuto ? null : getStoredSshPassword(body.cwd);
  const password = tryAuto ? undefined : body.password || stored || undefined;

  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath,
    useAgent,
    // tryAuto means "trust whatever the server presents and refresh the pin"
    // — that's what unblocks users whose host key has rotated. All other
    // paths keep the pin so a real MITM still gets refused.
    expectedHostFingerprint: tryAuto ? null : ws.sshKnownHostFp,
    password,
  };

  // Every login attempt evicts any pooled host for this connection key. The
  // pool exists to share live connections across consumers (chat/shell/fs),
  // not to short-circuit a fresh login. Without eviction, a previous failed
  // attempt's cached RemoteHost can keep reusing its original opts (password
  // isn't part of the pool key) and silently shadow our retry.
  disconnectHost(opts);

  let host;
  try {
    host = await getHost(opts);
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'login failed',
        needsPassword: !password,
      },
      { status: 200 },
    );
  }

  // Persist updates triggered by this attempt:
  //   • new host fingerprint when tryAuto succeeded (key rotation accepted)
  //   • identity / agent overrides the caller supplied
  //   • password if the caller asked us to remember a fresh one
  const newFp = host.getHostFingerprint();
  const persistedFingerprint =
    tryAuto && newFp && newFp !== ws.sshKnownHostFp;
  const persistedIdentity =
    body.identityPath !== undefined || body.useAgent !== undefined;
  const persistedPassword = !!body.rememberPassword && !!body.password;
  if (persistedFingerprint || persistedIdentity || persistedPassword) {
    upsertSshWorkspace({
      cwd: body.cwd,
      identityPath,
      useAgent,
      knownHostFingerprint: persistedFingerprint ? newFp : ws.sshKnownHostFp,
      rememberPassword: persistedPassword ? body.password : undefined,
    });
  }

  return Response.json({ ok: true });
}

function normalizePath(p: string | null): string | null {
  if (p == null) return null;
  const t = p.trim();
  return t.length ? t : null;
}
