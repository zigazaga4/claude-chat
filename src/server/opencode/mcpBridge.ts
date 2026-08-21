/**
 * Serves this app's own tools to OpenCode over HTTP MCP.
 *
 * The notebook, remote-SSH, and vision tools are built with the Agent SDK's
 * `createSdkMcpServer`, which returns `{ instance: McpServer }` — and that
 * instance is a genuine `@modelcontextprotocol/sdk` server, not an Agent-SDK
 * private type. The Agent SDK path hands the instance to an in-process
 * transport; this module hands the *same kind of instance* to an HTTP
 * transport so OpenCode, a separate process, can call the very same tools.
 *
 * That is the whole trick, and it is why switching backends did not require
 * reimplementing a single tool: `notebookTools.ts`, `sshTools.ts`, and
 * `visionTools.ts` are untouched and remain the one definition of each tool.
 * Both backends are thin adapters over shared code, and a fix to a tool lands
 * in both at once.
 *
 * ## Why factories rather than instances
 *
 * An `McpServer` binds to exactly one transport, so a stored instance could not
 * survive a client reconnect. Registrations therefore hold *factories*. The
 * closures each factory captures — the notebook's read/write pair, the SSH
 * workspace, the vision model — are shared across every instance it makes, so
 * a reconnect yields a fresh server wired to identical state.
 *
 * Stored on `globalThis` so dev-mode hot reloads don't strand a live OpenCode
 * server whose tools would abruptly 404.
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Builds a fresh, fully-wired MCP server over the caller's captured context.
 *
 * May be async: the SSH server probes the remote platform at construction time
 * to phrase its tool descriptions, and that probe has to finish before the
 * server can answer a `tools/list`.
 */
export type McpServerFactory = () => McpServer | Promise<McpServer>;

type Registration = {
  /** Keyed by the name OpenCode will see, e.g. `notebook` / `remote` / `vision`. */
  factories: Record<string, McpServerFactory>;
};

/** One live MCP session: a transport plus the server bound to it. */
type LiveSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  token: string;
};

type Store = {
  registrations: Map<string, Registration>;
  sessions: Map<string, LiveSession>;
};

const KEY = '__cc_opencodeMcpBridge__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) {
  g[KEY] = {
    registrations: new Map<string, Registration>(),
    sessions: new Map<string, LiveSession>(),
  } satisfies Store;
}
const store = g[KEY] as Store;

/**
 * Publish a set of tool servers and get back the token that addresses them.
 *
 * The returned disposer tears down every MCP session opened against the token,
 * so an abandoned turn cannot leave an SSH connection or notebook writer alive.
 * Call it in a `finally`.
 */
export function registerToolBundle(factories: Record<string, McpServerFactory>): {
  token: string;
  dispose: () => void;
} {
  const token = randomUUID();
  store.registrations.set(token, { factories });
  return {
    token,
    dispose: () => {
      store.registrations.delete(token);
      for (const [id, live] of store.sessions) {
        if (live.token !== token) continue;
        store.sessions.delete(id);
        // Best-effort: the peer may already be gone, and a failure to close a
        // transport must never surface as a turn-level error.
        void Promise.resolve()
          .then(() => live.server.close())
          .catch(() => {});
      }
    },
  };
}

/**
 * Handle one MCP HTTP request for `token`/`serverName`.
 *
 * Sessions are keyed by the `mcp-session-id` header the transport itself
 * mints on initialize. A request that carries a known id is routed to the
 * transport already holding that conversation; anything else starts a new one.
 */
export async function handleMcpRequest(
  token: string,
  serverName: string,
  request: Request,
): Promise<Response> {
  const registration = store.registrations.get(token);
  if (!registration) {
    return jsonRpcError(404, -32001, 'Unknown tool bundle (turn already ended)');
  }

  const factory = registration.factories[serverName];
  if (!factory) {
    return jsonRpcError(404, -32601, `No MCP server named "${serverName}"`);
  }

  const existingId = request.headers.get('mcp-session-id');
  const existing = existingId ? store.sessions.get(existingId) : undefined;
  if (existing) return existing.transport.handleRequest(request);

  const server = await factory();
  const transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        store.sessions.set(sessionId, { transport, server, token });
      },
      onsessionclosed: (sessionId) => {
        store.sessions.delete(sessionId);
      },
      // The MCP client here is a local OpenCode process, not a browser, so the
      // DNS-rebinding guard has nothing to protect against and its Host check
      // would only reject the loopback addresses we actually use.
      enableDnsRebindingProtection: false,
    });

  await server.connect(transport);
  return transport.handleRequest(request);
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}
