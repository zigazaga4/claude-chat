import type { NextRequest } from 'next/server';
import {
  deleteWorkspace,
  listWorkspaces,
  touchWorkspace,
} from '@/server/workspaces';
import { listConnectedHosts } from '@/server/sshHosts';
import { parseCwd } from '@/lib/cwd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const workspaces = listWorkspaces();
  // "Connected" means there is a live SSH connection to this HOST (user@host:port)
  // — NOT to one exact auth tuple. The pool key also encodes identity file +
  // agent, which legitimately differ between how a login was made (e.g. the
  // "Connect with SSH" / tryAuto path connects with no identity + agent off)
  // and what the workspace has saved. Matching the full key made a successful
  // connection read as "disconnected", wedging the UI on the login panel. Match
  // on host identity only so the badge reflects reality.
  const liveHosts = new Set(
    listConnectedHosts().map((h) => `${h.opts.user}|${h.opts.host}|${h.opts.port}`),
  );
  const decorated = workspaces.map((w) => {
    if (w.kind !== 'ssh') return { ...w, sshConnected: false };
    try {
      const p = parseCwd(w.cwd);
      if (p.kind !== 'ssh') return { ...w, sshConnected: false };
      return { ...w, sshConnected: liveHosts.has(`${p.user}|${p.host}|${p.port}`) };
    } catch {
      return { ...w, sshConnected: false };
    }
  });
  return Response.json({ workspaces: decorated });
}

export async function POST(req: NextRequest) {
  let body: { cwd?: unknown };
  try {
    body = (await req.json()) as { cwd?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
  if (!cwd) {
    return Response.json({ error: 'cwd is required' }, { status: 400 });
  }
  touchWorkspace(cwd, Date.now());
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get('cwd');
  if (!cwd) {
    return Response.json({ error: 'cwd query param is required' }, { status: 400 });
  }
  deleteWorkspace(cwd);
  return Response.json({ ok: true });
}
