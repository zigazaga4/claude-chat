/**
 * Management API for MCP servers — the UI's door to the same registry the
 * agent's `mcp` tools use.
 *
 * NOTE the path: this is `/api/mcp-servers`, deliberately NOT under
 * `/api/mcp/`. That prefix is exempt from the auth gate (see src/proxy.ts)
 * because the spawned OpenCode process calls it without a cookie; anything
 * that can edit configuration must stay behind the gate, and the exemption's
 * trailing slash is what keeps this route on the protected side.
 *
 * Secrets are write-only over this API: `env` and `headers` can be set, and
 * responses report only which KEYS exist, never their values.
 */

import type { NextRequest } from 'next/server';
import {
  attachToWorkspace,
  deleteMcpServer,
  detachFromWorkspace,
  getMcpServer,
  getMcpServerById,
  listAttachmentsForWorkspace,
  listMcpServers,
  listWorkspacesForServer,
  resolveForWorkspace,
  upsertMcpServer,
  type McpServerEntry,
  type McpTransport,
} from '@/server/mcpRegistry';
import { dropMcpClientsForServer, probeMcpEntry } from '@/server/mcpClientPool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TRANSPORTS: McpTransport[] = ['local-stdio', 'ssh-stdio', 'http'];

function isTransport(v: unknown): v is McpTransport {
  return typeof v === 'string' && (TRANSPORTS as string[]).includes(v);
}

/** Wire shape: never carries secret VALUES, only which keys are set. */
function toWire(entry: McpServerEntry, attachedCwds: string[]) {
  return {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    command: entry.command,
    url: entry.url,
    hostRef: entry.hostRef,
    enabled: entry.enabled,
    status: entry.status,
    envKeys: Object.keys(entry.env),
    headerKeys: Object.keys(entry.headers),
    attachedCwds,
    updatedAt: entry.updatedAt,
  };
}

function readStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

/**
 * GET /api/mcp-servers?cwd=…
 *
 * The whole library, each entry saying whether it is attached to `cwd`. One
 * round-trip drives the modal: the folder's live set and everything available
 * to add are the same list, differently flagged.
 */
export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get('cwd')?.trim() || null;
  const attachments = cwd ? listAttachmentsForWorkspace(cwd) : [];
  const attachedHere = new Map(attachments.map((a) => [a.serverId, a.enabled]));
  const servers = listMcpServers().map((entry) => ({
    ...toWire(entry, listWorkspacesForServer(entry.id)),
    attached: attachedHere.has(entry.id),
    attachedEnabled: attachedHere.get(entry.id) ?? false,
    /** Host this entry would actually use in `cwd`, after the follow rule. */
    resolvedHost: cwd ? resolveForWorkspace(entry, cwd).hostRef : entry.hostRef,
  }));
  return Response.json({ cwd, servers });
}

type UpsertBody = {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  url?: unknown;
  headers?: unknown;
  env?: unknown;
  hostRef?: unknown;
  /** Attach to this workspace as part of the save. */
  cwd?: unknown;
  /** Probe the connection before returning. */
  test?: unknown;
};

/**
 * POST /api/mcp-servers — create or update a definition, optionally attaching
 * it to a folder and probing it in the same call (what the modal's Save does).
 */
export async function POST(req: NextRequest) {
  let body: UpsertBody;
  try {
    body = (await req.json()) as UpsertBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
  if (!isTransport(body.transport)) {
    return Response.json(
      { error: `transport must be one of: ${TRANSPORTS.join(', ')}` },
      { status: 400 },
    );
  }
  const transport = body.transport;
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const hostRef = typeof body.hostRef === 'string' ? body.hostRef.trim() : '';
  const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';

  if (transport === 'http' && !url) {
    return Response.json({ error: 'http transport requires a url' }, { status: 400 });
  }
  if (transport !== 'http' && !command) {
    return Response.json(
      { error: `${transport} requires a command` },
      { status: 400 },
    );
  }
  // An ssh-stdio server with no pin follows its folder; if the folder it is
  // being attached to is local, it has nowhere to run.
  if (
    transport === 'ssh-stdio' &&
    !hostRef &&
    cwd &&
    !cwd.startsWith('ssh://')
  ) {
    return Response.json(
      {
        error:
          'This SSH server has no pinned host and the selected folder is local. Pin a host, or attach it to a folder on an SSH machine.',
      },
      { status: 400 },
    );
  }

  let entry: McpServerEntry;
  try {
    entry = upsertMcpServer({
      name,
      transport,
      command: command || null,
      url: url || null,
      headers: readStringRecord(body.headers),
      env: readStringRecord(body.env),
      hostRef: hostRef || null,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  if (cwd) attachToWorkspace(cwd, entry.id);
  // The definition just changed, so every host it was live on is stale.
  dropMcpClientsForServer(entry.id);

  let probe: { ok: boolean; tools?: string[]; error?: string } | null = null;
  if (body.test !== false) {
    const resolved = resolveForWorkspace(entry, cwd || null);
    try {
      const tools = await probeMcpEntry(resolved);
      probe = { ok: true, tools: tools.map((t) => t.name) };
    } catch (e) {
      probe = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const fresh = getMcpServerById(entry.id) ?? entry;
  return Response.json({
    server: toWire(fresh, listWorkspacesForServer(fresh.id)),
    probe,
  });
}

/**
 * PATCH /api/mcp-servers — attach or detach a definition for one folder.
 * Body: `{ name, cwd, attached: boolean }`.
 */
export async function PATCH(req: NextRequest) {
  let body: { name?: unknown; cwd?: unknown; attached?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
  if (!name || !cwd) {
    return Response.json({ error: 'name and cwd are required' }, { status: 400 });
  }
  const entry = getMcpServer(name);
  if (!entry) return Response.json({ error: `No server named "${name}"` }, { status: 404 });

  if (body.attached === false) {
    detachFromWorkspace(cwd, entry.id);
    dropMcpClientsForServer(entry.id);
    return Response.json({ ok: true, attached: false });
  }

  if (entry.transport === 'ssh-stdio' && !entry.hostRef && !cwd.startsWith('ssh://')) {
    return Response.json(
      {
        error: `"${entry.name}" follows its folder's SSH host, but this folder is local. Pin a host on the server first.`,
      },
      { status: 400 },
    );
  }
  attachToWorkspace(cwd, entry.id);
  const resolved = resolveForWorkspace(entry, cwd);
  try {
    const tools = await probeMcpEntry(resolved);
    return Response.json({
      ok: true,
      attached: true,
      probe: { ok: true, tools: tools.map((t) => t.name) },
    });
  } catch (e) {
    return Response.json({
      ok: true,
      attached: true,
      probe: { ok: false, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

/** DELETE /api/mcp-servers?name=… — remove a definition from every folder. */
export async function DELETE(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) {
    return Response.json({ error: 'name query param is required' }, { status: 400 });
  }
  const entry = getMcpServer(name);
  if (!entry) return Response.json({ error: `No server named "${name}"` }, { status: 404 });
  dropMcpClientsForServer(entry.id);
  deleteMcpServer(name);
  return Response.json({ ok: true });
}
