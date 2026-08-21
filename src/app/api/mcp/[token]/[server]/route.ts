/**
 * HTTP MCP endpoint the OpenCode backend calls back into.
 *
 * The direction of travel is inverted from every other route here: OpenCode
 * runs as its own process and is the *client*, reaching back for the tools this
 * app owns (notebook, remote SSH, vision). `/api/chat` publishes a bundle for
 * the duration of a turn and puts these URLs in OpenCode's config; OpenCode
 * connects and calls tools until the turn ends and the bundle is disposed.
 *
 * `token` addresses one turn's bundle and is a per-turn UUID that dies with it,
 * which is what keeps one conversation's tools — and its SSH workspace — from
 * being reachable by another. `server` selects which MCP server within it.
 *
 * All three verbs go to the same transport: POST carries JSON-RPC calls, GET
 * opens the server-to-client SSE stream, DELETE ends a session.
 */

import type { NextRequest } from 'next/server';
import { handleMcpRequest } from '@/server/opencode/mcpBridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ token: string; server: string }> };

async function handle(request: NextRequest, ctx: Ctx): Promise<Response> {
  const { token, server } = await ctx.params;
  return handleMcpRequest(token, server, request);
}

export async function POST(request: NextRequest, ctx: Ctx) {
  return handle(request, ctx);
}

export async function GET(request: NextRequest, ctx: Ctx) {
  return handle(request, ctx);
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  return handle(request, ctx);
}
