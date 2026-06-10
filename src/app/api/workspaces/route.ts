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
  // Build a set of "(user|host|port|identity|agent)" keys that are currently
  // live, then mark each SSH workspace accordingly.
  const liveKeys = new Set(listConnectedHosts().map((h) => h.key));
  const decorated = workspaces.map((w) => {
    if (w.kind !== 'ssh') return { ...w, sshConnected: false };
    try {
      const p = parseCwd(w.cwd);
      if (p.kind !== 'ssh') return { ...w, sshConnected: false };
      const key = [
        p.user,
        p.host,
        p.port,
        w.sshIdentityPath ?? '',
        w.sshUseAgent ? 'agent' : '',
      ].join('|');
      return { ...w, sshConnected: liveKeys.has(key) };
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
