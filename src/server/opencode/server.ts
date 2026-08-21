/**
 * Lifecycle for the OpenCode server backing one `/api/chat` stream.
 *
 * ## Why one server per stream
 *
 * An OpenCode server is configured once at spawn — its provider credentials and
 * MCP endpoints arrive as `OPENCODE_CONFIG_CONTENT` and cannot be changed
 * afterwards. The MCP endpoints are what make this app's own tools reachable,
 * and those tools are bound to one conversation: the notebook writes to one
 * conversation's notes, the remote tools to one SSH workspace. A server shared
 * across conversations would have no way to tell whose notebook a call belongs
 * to, because MCP carries no session correlation.
 *
 * So the server's lifetime is the stream's lifetime. That is not per-message:
 * a single `/api/chat` POST stays open across many turns (see
 * `activeChatStreams`), so the ~1.2s spawn is paid once per conversation-sitting
 * and amortised over every turn in it. It also mirrors how the Agent SDK path
 * scopes one `query()` per stream, which keeps the two backends reasoning alike.
 *
 * The isolation is a feature rather than a cost: one tenant's server holds one
 * tenant's credentials and one tenant's tools, which is the boundary a
 * multi-tenant deployment would need anyway.
 *
 * ## Caveat worth knowing
 *
 * `createOpencode` spreads the whole parent environment into the child, so the
 * spawned server sees every secret this process holds — including the API keys
 * of providers this turn is not using. `enabled_providers` pins model selection
 * to the one provider in play, so the extra keys cannot change what runs, but
 * they are present. Narrowing that requires spawning the binary directly rather
 * than through the SDK helper.
 */

import net from 'node:net';
import { Agent } from 'undici';
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
  type OpencodeClient,
} from '@opencode-ai/sdk';
import { getProvider, type ModelId } from '@/lib/models';
import {
  buildEnabledProviders,
  buildProviderConfig,
  isOpencodeProvider,
  qualifiedModel,
  smallModelFor,
} from './providers';
import { registerToolBundle, type McpServerFactory } from './mcpBridge';

/**
 * HTTP dispatcher for talking to the spawned OpenCode server.
 *
 * Node's built-in `fetch` (undici) defaults to a 300s `headersTimeout`, and
 * `session.prompt` is a single request that sends NOTHING back until the whole
 * turn is finished. To undici, a model that has been thinking and calling tools
 * for five minutes is indistinguishable from a dead server, so it aborts the
 * request and the turn dies with a bare `TypeError: fetch failed`
 * (`UND_ERR_HEADERS_TIMEOUT`). Short turns never hit it; long agentic ones —
 * exactly the ones worth running — always do.
 *
 * Both timeouts are therefore disabled rather than merely raised: any fixed
 * ceiling is just a longer fuse on the same bug. Turns are still bounded, just
 * by something meaningful instead of a stopwatch — the request is torn down
 * when the client disconnects (`dispose` stops the server, which closes the
 * socket and rejects the fetch), which is the same lifetime the Agent SDK path
 * gives a turn.
 *
 * One shared agent: undici pools per origin, and each stream's server gets its
 * own port, so this costs one pool entry per live stream.
 */
const PATIENT_AGENT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * `fetch` bound to the patient dispatcher.
 *
 * `dispatcher` is undici's own extension to `RequestInit` and is absent from
 * the DOM lib's type, hence the cast — it is read at runtime by the same
 * undici that backs `globalThis.fetch`.
 */
const patientFetch = (request: Request): Promise<Response> =>
  fetch(request, { dispatcher: PATIENT_AGENT } as RequestInit);

export type OpencodeBackend = {
  client: OpencodeClient;
  /** Base URL of the spawned server, for diagnostics. */
  url: string;
  /** Stops the server and tears down every MCP session it opened. */
  dispose: () => void;
};

export type StartOptions = {
  model: ModelId;
  /** Working directory OpenCode operates in. Must be a real local path. */
  cwd: string;
  /** This app's own tool servers, keyed by the name OpenCode will see. */
  mcpFactories: Record<string, McpServerFactory>;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

/**
 * Loopback origin OpenCode uses to call this app's MCP endpoints back.
 *
 * Always loopback: the MCP endpoints expose file, shell, and SSH tools, and the
 * OpenCode process is a local child, so there is never a reason for that
 * traffic to leave the machine. `CLAUDECHAT_SELF_URL` exists for deployments
 * that put the two in separate containers.
 */
function selfOrigin(env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDECHAT_SELF_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  return `http://127.0.0.1:${env.PORT?.trim() || '3000'}`;
}

/**
 * Reserve a free TCP port.
 *
 * Binding to port 0 and reading back what the OS assigned, then releasing it,
 * leaves a brief window where another process could take the port. That is
 * tolerable because the alternative — a fixed port — collides immediately when
 * two conversations run at once, which is the common case rather than the race.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Build the config handed to the spawned server.
 *
 * Permissions are all `allow` because this app already owns that decision: the
 * client-side permission mode and the chat route's own gating run before
 * anything reaches OpenCode. Leaving them at the default `ask` would strand
 * turns waiting on a TUI prompt that has no user in front of it.
 */
function buildConfig(opts: StartOptions, mcpToken: string): Config {
  const provider = getProvider(opts.model);
  if (!isOpencodeProvider(provider)) {
    throw new Error(`${opts.model} is not served by the OpenCode backend`);
  }

  const origin = selfOrigin(opts.env);
  const mcp: NonNullable<Config['mcp']> = {};
  for (const name of Object.keys(opts.mcpFactories)) {
    mcp[name] = {
      type: 'remote',
      url: `${origin}/api/mcp/${mcpToken}/${name}`,
      enabled: true,
      // These endpoints are in-process and unauthenticated by design; OAuth
      // auto-detection would only add a failed discovery round-trip.
      oauth: false,
      // The SSH-backed tools dial a remote host on first use, which can take
      // noticeably longer than the 5s default tool-listing timeout.
      timeout: 30_000,
    };
  }

  return {
    logLevel: 'ERROR',
    model: qualifiedModel(opts.model, opts.env),
    small_model: smallModelFor(opts.model, opts.env),
    provider: buildProviderConfig(provider, opts.env),
    enabled_providers: buildEnabledProviders(provider),
    ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'allow',
    },
    // Sharing uploads transcripts to a hosted service. Conversations here can
    // carry an SSH workspace's contents, so it stays off.
    share: 'disabled',
    // The server is spawned and discarded per stream; an autoupdate check on
    // each spawn would add latency and could swap the binary mid-conversation.
    autoupdate: false,
  };
}

/**
 * Spawn an OpenCode server wired to this app's tools, and connect a client.
 *
 * The returned `dispose` is safe to call more than once and must be called in a
 * `finally` — an orphaned server keeps a port, a child process, and any SSH
 * connections its tools opened.
 */
export async function startOpencodeBackend(
  opts: StartOptions,
): Promise<OpencodeBackend> {
  const bundle = registerToolBundle(opts.mcpFactories);
  let disposed = false;

  try {
    const config = buildConfig(opts, bundle.token);
    const port = await freePort();
    // Deliberately NOT `createOpencode()`, which is the two calls below plus a
    // client on the default `fetch` — and that default is what kills any turn
    // running longer than five minutes. See `PATIENT_AGENT`.
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port,
      config,
      signal: opts.signal,
      // A cold spawn resolves and loads the provider's AI SDK package on first
      // use, which is far slower than the steady-state boot.
      timeout: 60_000,
    });
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: patientFetch,
    });

    return {
      client,
      url: server.url,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try {
          server.close();
        } finally {
          bundle.dispose();
        }
      },
    };
  } catch (err) {
    bundle.dispose();
    throw err;
  }
}
