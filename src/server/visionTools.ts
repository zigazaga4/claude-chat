/**
 * Vision MCP server — `mcp__vision__analyze_image`.
 *
 * Z.AI's Anthropic-compatible endpoint injects its own server-side vision tool
 * ("analyze_image") on top of whatever tools the client registers. The model
 * reaches for it, Z.AI executes it provider-side, and on this app's traffic it
 * always failed with error 1210 — the image never actually reached it — which
 * left the model looping on a tool it couldn't use and poisoned the transcript
 * with server-tool ids Z.AI's own validator later rejects.
 *
 * The fix is to OWN the tool instead of fighting it. Registering a client tool
 * literally named `analyze_image` makes Z.AI route the call to us as an
 * ordinary `tool_use` (verified) rather than server-executing its broken one.
 * We then actually do the work: fetch the image (local file, remote SSH path,
 * or URL), hand it to a multimodal model as a real image block, and return the
 * analysis. The model gets a useful answer, the loop ends, and no server-tool
 * id is ever minted.
 *
 * The tool is only registered when the conversation runs on a provider that
 * injects it (Z.AI today), so Anthropic/DeepSeek conversations are untouched.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SFTPWrapper } from 'ssh2';
import { getHost, type ConnectOpts, type RemoteHost } from './sshHosts';
import { getStoredSshPassword, getWorkspace } from './workspaces';
import { buildProviderEnv } from './providers';
import { resolveRemotePath } from './remoteShell';
import { parseCwd } from '@/lib/cwd';
import { getProvider, getWireModelId, type ModelId } from '@/lib/models';

/** Model used to actually look at the image. Set per provider. */
const VISION_MODEL: Partial<Record<ReturnType<typeof getProvider>, ModelId>> = {
  // glm-5.2 is multimodal and is the user's subscription model — verified it
  // accepts Anthropic image blocks and reads them correctly.
  zai: 'glm-5.3',
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function mimeForPath(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? 'image/png';
}

type ImageBytes = { data: string; mime: string };

/** Read the image bytes named by `source` — a URL, remote SSH path, or local path. */
async function loadImage(
  source: string,
  opts: {
    isRemote: boolean;
    remoteHost: (() => Promise<RemoteHost>) | null;
    remoteBase: string;
    remotePlatform: () => Promise<'posix' | 'windows'>;
  },
): Promise<ImageBytes> {
  // URL — fetch directly.
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source} failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim();
    return {
      data: buf.toString('base64'),
      mime: mime && mime.startsWith('image/') ? mime : mimeForPath(source),
    };
  }

  // Remote SSH workspace — pull over SFTP.
  if (opts.isRemote && opts.remoteHost) {
    const host = await opts.remoteHost();
    const abs = resolveRemotePath(
      source,
      opts.remoteBase,
      await opts.remotePlatform(),
    );
    const sftp = await host.sftp();
    const buf = await new Promise<Buffer>((resolve, reject) => {
      (sftp as SFTPWrapper).readFile(abs, (e, d) =>
        e ? reject(e) : resolve(d as Buffer),
      );
    });
    return { data: buf.toString('base64'), mime: mimeForPath(abs) };
  }

  // Local file.
  const abs = path.isAbsolute(source)
    ? source
    : path.join(opts.remoteBase || process.cwd(), source);
  const buf = await fs.readFile(abs);
  return { data: buf.toString('base64'), mime: mimeForPath(abs) };
}

/** Call the multimodal model with the image + prompt, return its text answer. */
async function describeImage(
  model: ModelId,
  img: ImageBytes,
  prompt: string,
): Promise<string> {
  const env = buildProviderEnv(model, process.env);
  const base = env.ANTHROPIC_BASE_URL;
  const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!base || !key) throw new Error('vision provider is not configured');

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // buildProviderEnv already chose exactly one of these; send whichever
      // it set, matching the provider's expected auth header.
      ...(env.ANTHROPIC_API_KEY
        ? { 'x-api-key': env.ANTHROPIC_API_KEY }
        : { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` }),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: getWireModelId(model),
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: img.mime, data: img.data },
            },
            {
              type: 'text',
              text:
                prompt.trim() ||
                'Describe this image in detail. Note any text, UI elements, errors, or code visible.',
            },
          ],
        },
      ],
    }),
  });

  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    error?: { message?: string };
  };
  if (!res.ok || body.error) {
    throw new Error(body.error?.message || `vision request failed (${res.status})`);
  }
  return (body.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}

export type VisionToolContext = {
  /** The conversation's model, so we can pick the right vision backend. */
  model: ModelId;
  /** Workspace cwd — local path or ssh:// URL. */
  workspaceCwd: string;
};

/**
 * Whether this provider injects a server-side vision tool we need to intercept.
 * Only Z.AI does today; keep the check narrow so no other provider pays for it.
 */
export function providerInjectsVision(model: ModelId): boolean {
  return getProvider(model) === 'zai';
}

export function createVisionMcpServer(ctx: VisionToolContext) {
  const provider = getProvider(ctx.model);
  const visionModel = VISION_MODEL[provider] ?? ctx.model;

  const parsed = parseCwd(ctx.workspaceCwd);
  const isRemote = parsed.kind === 'ssh';
  const remoteBase = isRemote ? parsed.path : parsed.path || '';

  // Lazily bind to the SSH host only if/when a remote image is requested.
  let hostPromise: Promise<RemoteHost> | null = null;
  const remoteHost = isRemote
    ? (): Promise<RemoteHost> => {
        if (!hostPromise) {
          const ws = getWorkspace(ctx.workspaceCwd);
          const stored = getStoredSshPassword(ctx.workspaceCwd);
          const connect: ConnectOpts = {
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            identityPath: ws?.sshIdentityPath ?? null,
            useAgent: ws?.sshUseAgent ?? false,
            password: stored ?? undefined,
          };
          hostPromise = getHost(connect);
        }
        return hostPromise;
      }
    : null;
  const remotePlatform = async (): Promise<'posix' | 'windows'> =>
    isRemote ? (await remoteHost!()).platform() : 'posix';

  return createSdkMcpServer({
    name: 'vision',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'analyze_image',
        'Analyze an image or screenshot. Provide `imageSource` (a local path, a ' +
          'remote workspace path, or an http(s) URL) and a `prompt` describing ' +
          'what to look for. Returns a text description from a vision model.',
        {
          imageSource: z
            .string()
            .describe('Path (local or remote workspace) or http(s) URL of the image'),
          prompt: z
            .string()
            .optional()
            .describe('What to look for in the image (optional)'),
        },
        async (args): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
          try {
            const img = await loadImage(args.imageSource, {
              isRemote,
              remoteHost,
              remoteBase,
              remotePlatform,
            });
            const answer = await describeImage(
              visionModel,
              img,
              args.prompt ?? '',
            );
            return {
              content: [{ type: 'text', text: answer || '(no description returned)' }],
            };
          } catch (e) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Could not analyze ${args.imageSource}: ${
                    e instanceof Error ? e.message : 'unknown error'
                  }`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
