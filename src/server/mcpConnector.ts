/**
 * The MCP connector: folder-scoped registry entries become live tool servers,
 * and the agent gets tools to wire servers in itself.
 *
 * ## Proxying
 *
 * Each attached entry is served by an in-process SDK MCP server that proxies
 * at the protocol level — `tools/list` and `tools/call` handlers forward the
 * JSON to the real server through the client pool and return the JSON back.
 * No schema conversion, no tool-by-tool re-registration: whatever the real
 * server's input schemas are, they cross untouched. That one shape works for
 * every transport in mcpClientPool (local stdio, ssh stdio, http) and for
 * both engines, because both already attach in-process instances — the Agent
 * SDK via `mcpServers`, OpenCode via the HTTP bridge.
 *
 * Proxies are LAZY: the underlying client connects on the first list/call,
 * so a dead entry fails its own handshake instead of the turn.
 *
 * ## Scope
 *
 * Definitions are global; what is live is per FOLDER (see mcpRegistry). These
 * tools therefore act on two levels — `connect`/`attach`/`detach` change what
 * this folder uses, `remove` deletes a definition everywhere — and every one
 * of them names the folder in its result so the model can tell which it just
 * changed.
 *
 * ## Self-service
 *
 * The `mcp` server exposes those tools so the model can manage MCP servers
 * mid-conversation — install one on the SSH host with the remote shell, then
 * `mcp__mcp__connect` it into the harness. Changes take effect on the NEXT
 * message (both engines build their tool map per turn), which the tool
 * results say explicitly so the model doesn't hunt for tools that aren't
 * there yet.
 */

import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  attachToWorkspace,
  deleteMcpServer,
  detachFromWorkspace,
  getMcpServer,
  listMcpServers,
  listServersForWorkspace,
  listWorkspacesForServer,
  resolveForWorkspace,
  upsertMcpServer,
  type McpServerEntry,
  type McpTransport,
  type ResolvedMcpEntry,
} from './mcpRegistry';
import {
  acquireMcpClient,
  dropMcpClient,
  dropMcpClientsForServer,
  probeMcpEntry,
} from './mcpClientPool';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Conversation context the management tools act on. */
/**
 * How each engine namespaces MCP tools.
 *
 * The two disagree, and getting it wrong is not cosmetic: telling the model a
 * tool is called `godot_run_project` when the engine actually exposes
 * `mcp__godot__run_project` sends it looking for something that does not
 * exist, and the natural next move after "that tool isn't there" is to shell
 * out instead. Observed live — a folder with a working Godot server driven
 * entirely through raw CLI.
 *
 * This is the ONE definition of the rule. Everything that names an MCP tool in
 * a prompt or a tool result derives it from here, so the two spellings cannot
 * drift apart again.
 *
 *   Agent SDK   mcp__<server>__<tool>
 *   OpenCode    <server>_<tool>
 */
export type McpNaming = 'sdk' | 'opencode';

/** Tool glob for a third-party MCP server, e.g. `mcp__godot__*`. */
export function mcpToolGlob(server: string, style: McpNaming): string {
  return style === 'sdk' ? `mcp__${server}__*` : `${server}_*`;
}

/** A specific tool's full name, e.g. `mcp__godot__run_project`. */
export function mcpToolName(
  server: string,
  toolName: string,
  style: McpNaming,
): string {
  return style === 'sdk' ? `mcp__${server}__${toolName}` : `${server}_${toolName}`;
}

/** Prefix for the built-in MCP *manager* tools (list/connect/attach/…). */
export function mcpManagerPrefix(style: McpNaming): string {
  return style === 'sdk' ? 'mcp__mcp__' : 'mcp_';
}

export type McpConnectorContext = {
  /** Workspace cwd — `ssh://…` for remote conversations, a local path otherwise. */
  workspaceCwd: string;
  isRemote: boolean;
  /**
   * Which engine is serving this turn. Decides how this server's own tool
   * descriptions and results spell the tools it connects — see `McpNaming`.
   */
  style: McpNaming;
};

/**
 * Factory for one attached entry's proxy. Returns the same shape the built-in
 * servers do, so callers use it exactly like `createNotebookMcpServer`.
 */
export function proxyMcpServerFactory(entry: ResolvedMcpEntry) {
  return () => {
    const server = createSdkMcpServer({ name: entry.name, version: '0.1.0' });
    // Raw protocol handlers replace the high-level ones set at construction,
    // turning the server into a pure pass-through for tools.
    const low = server.instance.server;
    // Declare the tools capability by hand.
    //
    // The SDK only registers it inside `setToolRequestHandlers()`, which runs
    // when a tool is added through the HIGH-LEVEL api — the very thing this
    // proxy skips so it can forward the upstream tool list verbatim. Without
    // this line the server advertises no capabilities at all, and a client is
    // required to refuse the call before it is even sent: the CLI throws
    // "Server does not support tools (required for tools/list)" and the whole
    // turn dies on the spot. It looks exactly like the user pressed stop, and
    // it takes down every conversation in a workspace that has any MCP server
    // attached — not just the one that is misbehaving.
    low.registerCapabilities({ tools: {} });
    low.setRequestHandler(ListToolsRequestSchema, async () => {
      const client = await acquireMcpClient(entry);
      const res = await client.listTools();
      return {
        tools: res.tools,
        ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}),
      };
    });
    low.setRequestHandler(CallToolRequestSchema, async (req) => {
      const client = await acquireMcpClient(entry);
      return client.callTool({
        name: req.params.name,
        arguments: req.params.arguments,
        _meta: req.params._meta,
      });
    });
    return server;
  };
}

const TRANSPORT_FIELD: z.ZodType<McpTransport> = z
  .enum(['local-stdio', 'ssh-stdio', 'http'])
  .describe(
    "local-stdio: spawn a command on THIS machine. ssh-stdio: run a command on an SSH host (defaults to this folder's host). http: connect to a streamable-HTTP MCP endpoint.",
  );

function summarizeTools(tools: { name: string }[]): string {
  const names = tools.map((t) => t.name);
  const head = names.slice(0, 25).join(', ');
  return names.length > 25 ? `${head}, … (+${names.length - 25} more)` : head;
}

/** One-line description of where a definition runs. */
function whereLine(entry: McpServerEntry): string {
  if (entry.transport === 'http') return `http ${entry.url ?? '??'}`;
  if (entry.transport === 'local-stdio') return `local: ${entry.command ?? '??'}`;
  return entry.hostRef
    ? `ssh ${entry.hostRef}: ${entry.command ?? '??'}`
    : `ssh (this folder's host): ${entry.command ?? '??'}`;
}

/**
 * The management server. Both engines see it (`mcp__mcp__connect` on the
 * Agent SDK backend, `mcp_connect` on OpenCode) with identical bodies.
 */
export function createMcpManagerServer(ctx: McpConnectorContext) {
  const folder = ctx.workspaceCwd;
  /** Bind a stored definition to THIS folder, ready to connect. */
  const resolve = (entry: McpServerEntry): ResolvedMcpEntry =>
    resolveForWorkspace(entry, folder);

  return createSdkMcpServer({
    name: 'mcp',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'list',
        'List MCP servers: which are live in THIS folder, and which others exist in the global library ready to attach. MCP servers are configured per folder — every conversation in a folder gets that folder\'s set.',
        {},
        async (): Promise<ToolResult> => {
          const live = listServersForWorkspace(folder);
          const liveIds = new Set(live.map((e) => e.id));
          const others = listMcpServers().filter((e) => !liveIds.has(e.id));
          const lines: string[] = [`Folder: ${folder}`, ''];
          if (live.length === 0) {
            lines.push('Live here: none.');
          } else {
            lines.push('Live here:');
            for (const e of live) {
              lines.push(`  - ${e.name} — ${whereLine(e)} — ${e.status ?? 'unknown'}`);
            }
          }
          if (others.length > 0) {
            lines.push('', 'In the library (not attached here — use `attach`):');
            for (const e of others) {
              lines.push(
                `  - ${e.name} — ${whereLine(e)}${e.enabled ? '' : ' [disabled]'}`,
              );
            }
          }
          if (live.length === 0 && others.length === 0) {
            lines.push(
              '',
              'Nothing configured yet. Use `connect` to add a server — e.g. one installed on this folder\'s SSH host (ssh-stdio), a local command (local-stdio), or a streamable-HTTP endpoint (http).',
            );
          }
          return ok(lines.join('\n'));
        },
      ),
      tool(
        'connect',
        `Add an MCP server and make it live in THIS folder, connecting immediately. This is how you wire a server you just set up (e.g. installed over SSH) into your own toolset: after a successful connect, its tools appear as \`${mcpToolGlob('<name>', ctx.style)}\` from your NEXT message. If the server needs installing or starting first, do that with the shell tools (on an SSH host: \`mcp__remote__bash\`) before calling this. The definition is saved globally, so other folders can \`attach\` it later.`,
        {
          name: z
            .string()
            .describe(
              `Short identifier for the server. Becomes the tool namespace, e.g. name "blender" → tools like ${mcpToolName('blender', 'get_scene_info', ctx.style)}. Letters/digits/dash/underscore.`,
            ),
          transport: TRANSPORT_FIELD,
          command: z
            .string()
            .optional()
            .describe(
              'For stdio transports: the command that runs the MCP server. local-stdio: a shell-style command line, e.g. "uvx blender-mcp". ssh-stdio: the exact command line to run on the host (PowerShell syntax on Windows hosts), e.g. "npx -y mcp-server-foo".',
            ),
          url: z
            .string()
            .optional()
            .describe('For http transport: the endpoint URL, e.g. http://127.0.0.1:3000/mcp.'),
          headers: z
            .record(z.string(), z.string())
            .optional()
            .describe('For http transport: request headers (e.g. Authorization).'),
          env: z
            .record(z.string(), z.string())
            .optional()
            .describe('Environment variables for the spawned process (stdio transports).'),
          host: z
            .string()
            .optional()
            .describe(
              "For ssh-stdio: PIN the server to this ssh:// host. Omit to let it follow whichever folder it is attached to — the usual choice, and it resolves to this folder's host here.",
            ),
        },
        async (args): Promise<ToolResult> => {
          if (args.transport !== 'http' && !args.command?.trim()) {
            return err(`transport ${args.transport} requires a command.`);
          }
          if (args.transport === 'http' && !args.url?.trim()) {
            return err('http transport requires a url.');
          }
          // A pinned host is stored; unpinned entries follow the folder, which
          // `resolve` fills in below. An ssh-stdio server in a local folder
          // with no pin has nowhere to run, so say so now rather than at the
          // handshake.
          const pinned = args.host?.trim() || null;
          if (args.transport === 'ssh-stdio' && !pinned && !ctx.isRemote) {
            return err(
              'ssh-stdio needs a host: this folder is local, so there is no host to follow. Pass `host` (ssh://user@host:port/…) to pin one, or attach this server to a folder on an SSH machine.',
            );
          }

          let entry: McpServerEntry;
          try {
            entry = upsertMcpServer({
              name: args.name,
              transport: args.transport,
              command: args.command?.trim() ?? null,
              url: args.url?.trim() ?? null,
              headers: args.headers ?? {},
              env: args.env ?? {},
              hostRef: pinned,
            });
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
          attachToWorkspace(folder, entry.id);

          // Editing a definition invalidates every host it was live on.
          dropMcpClientsForServer(entry.id);
          const resolved = resolve(entry);
          try {
            const tools = await probeMcpEntry(resolved);
            return ok(
              `Connected "${entry.name}" in ${folder} — ${tools.length} tool(s): ${summarizeTools(tools)}.\n` +
                `Running on: ${whereLine(resolved)}.\n` +
                `Its tools are available from your NEXT message (as ${mcpToolGlob(entry.name, ctx.style)}).`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return err(
              `Saved "${entry.name}" and attached it to ${folder}, but the connection failed: ${msg}\n` +
                `The entry stays configured — fix the server (it may need installing or starting on the host) and call connect again, or detach/remove it.`,
            );
          }
        },
      ),
      tool(
        'attach',
        'Make an EXISTING library server live in this folder, and connect it. Use after `list` shows a server configured elsewhere that you want here too.',
        {
          name: z.string().describe('Name of the server in the library.'),
        },
        async (args): Promise<ToolResult> => {
          const entry = getMcpServer(args.name);
          if (!entry) {
            return err(
              `No MCP server named "${args.name}" in the library. Use \`list\` to see what exists, or \`connect\` to define it.`,
            );
          }
          if (entry.transport === 'ssh-stdio' && !entry.hostRef && !ctx.isRemote) {
            return err(
              `"${entry.name}" follows its folder's SSH host, but this folder is local. Pin a host on the server, or attach it to a folder on an SSH machine.`,
            );
          }
          attachToWorkspace(folder, entry.id);
          const resolved = resolve(entry);
          try {
            const tools = await probeMcpEntry(resolved);
            return ok(
              `Attached "${entry.name}" to ${folder} — ${tools.length} tool(s): ${summarizeTools(tools)}.\n` +
                `Running on: ${whereLine(resolved)}.\nAvailable from your NEXT message.`,
            );
          } catch (e) {
            return err(
              `Attached "${entry.name}" to ${folder} but the connection failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      ),
      tool(
        'detach',
        'Stop using an MCP server in THIS folder. The definition stays in the library and other folders keep it. Its tools disappear from your next message.',
        {
          name: z.string().describe('Name of the server to remove from this folder.'),
        },
        async (args): Promise<ToolResult> => {
          const entry = getMcpServer(args.name);
          if (!entry) return err(`No MCP server named "${args.name}".`);
          if (!detachFromWorkspace(folder, entry.id)) {
            return err(`"${args.name}" is not attached to ${folder}.`);
          }
          dropMcpClient(resolve(entry).poolKey);
          return ok(
            `Detached "${args.name}" from ${folder}. It is still in the library — \`attach\` brings it back.`,
          );
        },
      ),
      tool(
        'remove',
        'Delete an MCP server definition entirely, from every folder that uses it. Use `detach` instead to only stop using it here.',
        {
          name: z.string().describe('Name of the server to delete.'),
        },
        async (args): Promise<ToolResult> => {
          const entry = getMcpServer(args.name);
          if (!entry) return err(`No MCP server named "${args.name}".`);
          const folders = listWorkspacesForServer(entry.id);
          dropMcpClientsForServer(entry.id);
          deleteMcpServer(args.name);
          const also = folders.filter((f) => f !== folder);
          return ok(
            `Deleted "${args.name}" from the library.` +
              (also.length > 0
                ? ` It was also in use by ${also.length} other folder(s): ${also.join(', ')}.`
                : ''),
          );
        },
      ),
      tool(
        'test',
        'Try connecting to an MCP server WITHOUT saving or attaching it — same parameters as `connect`. Use it to verify a command/URL works first.',
        {
          transport: TRANSPORT_FIELD,
          command: z.string().optional(),
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          host: z
            .string()
            .optional()
            .describe("For ssh-stdio: host to pin; defaults to this folder's host."),
        },
        async (args): Promise<ToolResult> => {
          if (args.transport !== 'http' && !args.command?.trim()) {
            return err(`transport ${args.transport} requires a command.`);
          }
          if (args.transport === 'http' && !args.url?.trim()) {
            return err('http transport requires a url.');
          }
          const pinned = args.host?.trim() || null;
          if (args.transport === 'ssh-stdio' && !pinned && !ctx.isRemote) {
            return err(
              'ssh-stdio needs a host: this folder is local, so pass `host` to pin one.',
            );
          }
          // Throwaway definition: never persisted, pool slot dropped after use.
          const scratch: McpServerEntry = {
            id: `test-${randomUUID()}`,
            name: `test:${args.transport}`,
            transport: args.transport,
            command: args.command?.trim() ?? null,
            url: args.url?.trim() ?? null,
            headers: args.headers ?? {},
            env: args.env ?? {},
            hostRef: pinned,
            enabled: false,
            status: null,
            createdAt: 0,
            updatedAt: 0,
          };
          const resolved = resolve(scratch);
          try {
            const tools = await probeMcpEntry(resolved);
            return ok(
              `Connection OK on ${whereLine(resolved)} — ${tools.length} tool(s): ${summarizeTools(tools)}`,
            );
          } catch (e) {
            return err(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            dropMcpClient(resolved.poolKey);
          }
        },
      ),
    ],
  });
}
