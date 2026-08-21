/**
 * SDK MCP server giving an SSH-scoped conversation a way back to the machine
 * cloudchat itself runs on. Namespaced `mcp__local__<name>`.
 *
 * WHY THIS EXISTS
 *
 * When a workspace is an ssh:// folder the chat route blocks every built-in
 * filesystem tool (Bash, Read, Write, Edit, Glob, Grep, LS) and hands the model
 * `mcp__remote__*` instead. That block is deliberate and load-bearing: without
 * it the model reaches for `Read`, gets a file from the wrong machine, and
 * neither side notices. The cost is that such a conversation becomes strictly
 * one-way — it can no longer touch the box it is actually hosted on, even when
 * that is the whole point of the request (copy a build artifact down, look at a
 * local key, run a local CLI that talks to the remote).
 *
 * So this restores the other direction, under names that cannot be confused
 * with either the built-ins or the remote set.
 *
 * WHY ONLY THREE TOOLS
 *
 * The remote server mirrors all seven built-ins because the remote host is
 * where the work happens. Here it is the opposite: this is an escape hatch, not
 * a workspace, and every tool added to a turn costs schema in the context
 * window of every subsequent request. bash/read/write is the smallest set that
 * is genuinely complete — glob, grep, ls and edit are all reachable through
 * `bash` on a machine the model is not primarily working in, whereas reading an
 * image and writing a multi-line file are painful to express as shell.
 *
 * The read/write pair is shaped exactly like its remote and built-in
 * counterparts (same parameter names, same cat -n output, same image handling)
 * via ./fileToolShared, so nothing new has to be learned to use them.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  IMAGE_MIME_BY_EXT,
  READ_DEFAULT_LIMIT,
  err,
  image,
  ok,
  renderTextRead,
  type ToolResult,
} from './fileToolShared';

/**
 * Ceiling on captured command output. The SSH equivalent has no cap and that
 * is a known way to turn one `find /` into a few hundred MB of resident string
 * that then rides along in the turn's block array and into SQLite. Truncating
 * loudly is better than that: the model can narrow the command and retry.
 */
const MAX_OUTPUT_BYTES = 100_000;

/** Matches the 2 MB ceiling /api/fs/read already enforces for local files. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Images are base64'd into the message, which inflates by a third and is then
 * persisted forever. 8 MB of source is already a ~11 MB content block.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Absolute paths win; anything else resolves against the home directory. */
function resolveLocal(p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(os.homedir(), p);
}

/** Accumulates up to `MAX_OUTPUT_BYTES`, then stops and records that it did. */
function makeCappedSink() {
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(d: Buffer) {
      if (truncated) return;
      const room = MAX_OUTPUT_BYTES - bytes;
      if (d.length >= room) {
        chunks.push(d.subarray(0, room).toString('utf8'));
        bytes = MAX_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      chunks.push(d.toString('utf8'));
      bytes += d.length;
    },
    get text() {
      return chunks.join('');
    },
    get truncated() {
      return truncated;
    },
  };
}

type LocalRun = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
};

function runLocalCommand(command: string, timeoutMs: number): Promise<LocalRun> {
  return new Promise<LocalRun>((resolve) => {
    // `-l` so the command sees the same PATH the user's login shell has —
    // nvm, cargo, bun and the rest live there and a non-login shell finds none
    // of them. `-c` because this is one-shot, not interactive.
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: os.homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = makeCappedSink();
    const errSink = makeCappedSink();
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errSink.push(d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: a wedged child that ignores TERM is
      // exactly the case the timeout exists for.
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: `[failed to start: ${e.message}]`,
        code: null,
        signal: null,
        timedOut: false,
        truncated: false,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: out.text,
        stderr: errSink.text,
        code,
        signal,
        timedOut,
        truncated: out.truncated || errSink.truncated,
      });
    });
  });
}

/**
 * Built once per turn, like the remote server. Takes no arguments — "local" is
 * always this process's own machine, and the home directory is the only cwd
 * that means anything when the workspace lives somewhere else entirely.
 */
export function createLocalMcpServer() {
  const home = os.homedir();
  const hostname = os.hostname();
  // Repeated in all three descriptions on purpose. The single most likely
  // failure is the model reaching for these to touch workspace files, and the
  // description is the only place that misconception can be corrected.
  const scopeNote =
    `This runs on the LOCAL machine hosting cloudchat (${hostname}) — NOT on the SSH host your workspace lives on. ` +
    `Use the mcp__remote__* tools for anything inside the workspace. Reach for this one only when you specifically need this machine.`;

  return createSdkMcpServer({
    name: 'local',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'bash',
        `Execute a shell command on the local machine (${hostname}), the one running cloudchat. ` +
          `Starts in ${home}; use \`cd\` for anywhere else. Runs through bash -lc, so your login PATH applies. ` +
          `Returns stdout and stderr, truncated past ${MAX_OUTPUT_BYTES.toLocaleString()} bytes. ` +
          scopeNote,
        {
          command: z.string().describe('Command to execute on the local machine'),
          description: z
            .string()
            .optional()
            .describe('Short label of what this command does'),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .max(10 * 60_000)
            .optional()
            .describe('Hard timeout in milliseconds (default: 120000)'),
        },
        async (args): Promise<ToolResult> => {
          const r = await runLocalCommand(
            args.command,
            args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
          );
          const body =
            r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : '');
          const notes = [
            `exit ${r.code ?? '?'}`,
            r.signal ? `signal ${r.signal}` : '',
            r.timedOut ? 'killed after timeout' : '',
            r.truncated ? 'output truncated' : '',
          ].filter(Boolean);
          const tail = `\n[${notes.join(' — ')}]`;
          return r.code === 0 ? ok(body + tail) : err(body + tail);
        },
      ),

      tool(
        'read',
        `Reads a file from the LOCAL machine's filesystem (${hostname}).

Usage:
- file_path should be absolute; a relative path resolves against ${home}
- By default it reads up to ${READ_DEFAULT_LIMIT} lines from the start of the file
- offset and limit are available for long files, but prefer reading the whole file when you can
- Results come back in cat -n format, line numbers starting at 1
- Images (png, jpg, jpeg, gif, webp) are returned visually so you can actually see them
- Directories are not readable here — use the bash tool with ls
- Text files are capped at ${(MAX_READ_BYTES / 1048576).toFixed(0)} MB; for anything larger use bash with head/sed

${scopeNote}`,
        {
          file_path: z
            .string()
            .describe('The absolute path to the file to read on the local machine'),
          offset: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'The line number to start reading from. Only provide if the file is too large to read at once',
            ),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'The number of lines to read. Only provide if the file is too large to read at once.',
            ),
        },
        async (args): Promise<ToolResult> => {
          const abs = resolveLocal(args.file_path);
          let stat;
          try {
            stat = await fs.stat(abs);
          } catch (e) {
            return err(
              `Failed to read ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
          if (stat.isDirectory()) {
            return err(
              `${abs} is a directory. Use mcp__local__bash with \`ls\` to list it.`,
            );
          }
          if (!stat.isFile()) return err(`${abs} is not a regular file`);

          const imageMime = IMAGE_MIME_BY_EXT[path.extname(abs).toLowerCase()];
          if (imageMime) {
            if (stat.size > MAX_IMAGE_BYTES) {
              return err(
                `${abs} is ${(stat.size / 1048576).toFixed(1)} MB, over the ${(MAX_IMAGE_BYTES / 1048576).toFixed(0)} MB image limit. Resize it first, e.g. with ImageMagick via mcp__local__bash.`,
              );
            }
            try {
              const buf = await fs.readFile(abs);
              return image(
                buf.toString('base64'),
                imageMime,
                `Image at ${abs} (${stat.size} bytes, ${imageMime}):`,
              );
            } catch (e) {
              return err(
                `Failed to read image ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
              );
            }
          }

          if (stat.size > MAX_READ_BYTES) {
            return err(
              `${abs} is ${(stat.size / 1048576).toFixed(1)} MB, over the ${(MAX_READ_BYTES / 1048576).toFixed(0)} MB limit for this tool. Use mcp__local__bash with head/sed/rg to pull out the part you need.`,
            );
          }
          let buf: Buffer;
          try {
            buf = await fs.readFile(abs);
          } catch (e) {
            return err(
              `Failed to read ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
          return renderTextRead({
            buf,
            label: abs,
            offset: args.offset,
            limit: args.limit,
            binaryHint:
              'The local read tool only renders text files and the supported image types (png, jpg, jpeg, gif, webp).',
          });
        },
      ),

      tool(
        'write',
        `Writes a file to the LOCAL machine's filesystem (${hostname}), creating parent directories as needed and overwriting any existing file.

Usage:
- file_path should be absolute; a relative path resolves against ${home}
- Prefer reading the file first when overwriting something you did not just create
- Content is written as UTF-8

${scopeNote}`,
        {
          file_path: z
            .string()
            .describe('The absolute path to the file to write on the local machine'),
          content: z.string().describe('The content to write to the file'),
        },
        async (args): Promise<ToolResult> => {
          const abs = resolveLocal(args.file_path);
          try {
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, args.content, 'utf8');
          } catch (e) {
            return err(
              `Failed to write ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
          return ok(
            `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${abs}`,
          );
        },
      ),
    ],
  });
}
