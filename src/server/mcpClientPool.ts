/**
 * Pool of live MCP client connections behind the registry.
 *
 * A registry entry says HOW to reach an MCP server; this module holds the
 * actual connection so the cost is paid once. Clients survive across turns
 * (a `uvx` cold start is seconds) and are re-created when an entry's config
 * changes — the pool keys by entry id and re-fingerprint on every acquire.
 *
 * Three transports, all standard MCP framing (newline-delimited JSON-RPC on
 * stdio, or streamable HTTP):
 *
 *   local-stdio  child process on this machine (StdioClientTransport)
 *   ssh-stdio    process on a pooled SSH host — the framing rides an ssh2
 *                exec channel, so nothing but the server itself needs to be
 *                installed there, and the host's credentials/pinning are the
 *                same ones the remote tools use
 *   http         streamable HTTP endpoint, native client transport
 *
 * Lives on globalThis (dev-mode HMR) like every other long-lived store here.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ClientChannel } from 'ssh2';
import { connectOptsForWorkspace, getHost } from './sshHosts';
import {
  entryFingerprint,
  setMcpStatus,
  type ResolvedMcpEntry,
} from './mcpRegistry';

/** A connection failure that names the entry — surfaced to the model verbatim. */
export class McpConnectError extends Error {
  constructor(entryName: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`${entryName}: ${msg}`);
    this.name = 'McpConnectError';
  }
}

/**
 * MCP stdio framing over a raw ssh2 exec channel. Same wire format the local
 * stdio transport speaks — newline-delimited JSON — just piped through SSH.
 * The channel comes from the pooled RemoteHost, so connection reuse, auth,
 * and host-key pinning are whatever the pool already does for that host.
 */
class SshStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private channel: ClientChannel | null = null;
  private buffer = new ReadBuffer();
  private closed = false;

  constructor(private readonly openChannel: () => Promise<ClientChannel>) {}

  async start(): Promise<void> {
    if (this.channel) throw new Error('SshStdioTransport already started');
    const channel = await this.openChannel();
    this.channel = channel;
    channel.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    channel.on('error', (err: Error) => this.onerror?.(err));
    channel.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const channel = this.channel;
    if (!channel || this.closed) {
      throw new Error('SshStdioTransport is not connected');
    }
    await new Promise<void>((resolve, reject) => {
      channel.write(JSON.stringify(message) + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const channel = this.channel;
    this.channel = null;
    channel?.close();
    this.onclose?.();
  }
}

/**
 * Shell-split a command line for local stdio spawning, honouring simple
 * single/double quoting. Not a full shell parser — entries are written by
 * the user or the model, and anything needing real shell syntax belongs in
 * an ssh-stdio entry where the remote shell does the parsing.
 */
export function splitCommand(line: string): { command: string; args: string[] } {
  const tokens = line.trim().match(/"([^"]*)"|'([^']*)'|(\S+)/g) ?? [];
  const parts = tokens.map((t) =>
    t.length >= 2 && (t.startsWith('"') || t.startsWith("'")) && t.endsWith(t[0])
      ? t.slice(1, -1)
      : t,
  );
  const [command, ...args] = parts;
  if (!command) throw new Error('Empty command');
  return { command, args };
}

async function buildTransport(entry: ResolvedMcpEntry): Promise<Transport> {
  switch (entry.transport) {
    case 'http': {
      if (!entry.url) throw new Error('http MCP entry has no url');
      return new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers },
      });
    }
    case 'ssh-stdio': {
      if (!entry.command) throw new Error('ssh-stdio MCP entry has no command');
      if (!entry.hostRef) {
        throw new Error(
          'ssh-stdio server has no host: it is attached to a local folder and ' +
            'is not pinned to one. Pin a host on the server, or attach it to a ' +
            'folder on an SSH machine.',
        );
      }
      const opts = connectOptsForWorkspace(entry.hostRef);
      if (!opts) throw new Error(`no SSH host resolves from "${entry.hostRef}"`);
      const host = await getHost(opts);
      const command = entry.command;
      // execRaw drains stderr for us; a chatty server cannot stall the window.
      return new SshStdioTransport(() => host.execRaw(command));
    }
    case 'local-stdio': {
      if (!entry.command) throw new Error('local-stdio MCP entry has no command');
      const { command, args } = splitCommand(entry.command);
      return new StdioClientTransport({
        command,
        args,
        // Registry env rides on top of the safe default set (PATH, HOME, …);
        // a bare registry env would strand servers that shell out.
        env: { ...getDefaultEnvironment(), ...entry.env },
        stderr: 'ignore',
      });
    }
  }
}

type Pooled = {
  client: Client;
  fingerprint: string;
  lastUsed: number;
};

type Store = { pool: Map<string, Pooled>; timer: NodeJS.Timeout | null };

const KEY = '__cc_mcpClientPool__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) g[KEY] = { pool: new Map(), timer: null } satisfies Store;
const store = g[KEY] as Store;

/** Idle connections die after this long — an abandoned MCP shouldn't hold a process forever. */
const IDLE_MS = 10 * 60_000;

function ensureSweeper(): void {
  if (store.timer) return;
  store.timer = setInterval(() => {
    const now = Date.now();
    for (const [id, pooled] of store.pool) {
      if (now - pooled.lastUsed < IDLE_MS) continue;
      store.pool.delete(id);
      void pooled.client.close().catch(() => {});
    }
  }, 60_000);
  store.timer.unref?.();
}

/**
 * The live client for a resolved entry, connecting on demand. Reconnects when
 * the entry's config changed since the pooled client was made; a client whose
 * transport died removes itself from the pool via onclose, so the next
 * acquire respawns it.
 *
 * Keyed by `poolKey` — (definition, resolved host) — not by definition alone.
 * One "unreal" server attached to folders on two different machines is two
 * live processes on two hosts, and keying by id would hand the second folder
 * the first machine's connection.
 *
 * @throws {McpConnectError} with the underlying failure — callers surface it
 *   to the model, and the entry's registry status records it.
 */
export async function acquireMcpClient(entry: ResolvedMcpEntry): Promise<Client> {
  ensureSweeper();
  const fp = entryFingerprint(entry);
  const existing = store.pool.get(entry.poolKey);
  if (existing) {
    if (existing.fingerprint === fp) {
      existing.lastUsed = Date.now();
      return existing.client;
    }
    // Config drifted — stale client out, fresh one in.
    store.pool.delete(entry.poolKey);
    void existing.client.close().catch(() => {});
  }

  let client: Client;
  try {
    const transport = await buildTransport(entry);
    client = new Client({ name: 'cloudchat-mcp', version: '0.1.0' });
    await client.connect(transport);
  } catch (cause) {
    setMcpStatus(entry.name, `failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    throw new McpConnectError(entry.name, cause);
  }
  setMcpStatus(entry.name, 'connected');

  const pooled: Pooled = { client, fingerprint: fp, lastUsed: Date.now() };
  client.onclose = () => {
    if (store.pool.get(entry.poolKey) === pooled) store.pool.delete(entry.poolKey);
  };
  store.pool.set(entry.poolKey, pooled);
  return client;
}

/** Connect and list tools — the probe behind `connect` / `test`. */
export async function probeMcpEntry(
  entry: ResolvedMcpEntry,
): Promise<{ name: string; description?: string }[]> {
  const client = await acquireMcpClient(entry);
  const res = await client.listTools();
  return res.tools.map((t) => ({ name: t.name, description: t.description }));
}

/** Drop one pooled connection (disconnect / re-probe paths). */
export function dropMcpClient(poolKey: string): void {
  const pooled = store.pool.get(poolKey);
  if (!pooled) return;
  store.pool.delete(poolKey);
  void pooled.client.close().catch(() => {});
}

/**
 * Drop every pooled connection for a definition, across all hosts. Used when
 * the definition is edited or deleted — its config just changed everywhere.
 */
export function dropMcpClientsForServer(serverId: string): void {
  for (const key of [...store.pool.keys()]) {
    if (key.startsWith(`${serverId}::`)) dropMcpClient(key);
  }
}
