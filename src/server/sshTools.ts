/**
 * SDK MCP server that exposes remote-host equivalents of the built-in
 * Bash/Read/Write/Edit/Glob/Grep/LS tools. Constructed per-conversation,
 * bound to a single SSH workspace, so the model can keep using the same
 * mental model — these tools are namespaced as mcp__remote__<name>.
 *
 * The remote Read/Write/Edit tools are deliberately shaped to be a 1:1 mirror
 * of the built-in Read/Write/Edit shipped with the Claude Code SDK:
 *   - Same parameter names (file_path, offset, limit, content,
 *     old_string, new_string, replace_all)
 *   - Same description copy (adapted only to say "remote SSH filesystem")
 *   - Same default of 2000 lines for Read, same cat -n line-numbered output
 *   - Image files come back as MCP `image` content blocks so the multimodal
 *     model can actually see screenshots, photos, etc. on the remote host
 */

import { Buffer } from 'node:buffer';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SFTPWrapper } from 'ssh2';
import { getHost, type ConnectOpts, type RemoteHost } from './sshHosts';
import { getStoredSshPassword, getWorkspace } from './workspaces';
import { parseCwd } from '@/lib/cwd';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
function image(data: string, mimeType: string, note?: string): ToolResult {
  const content: ContentBlock[] = [{ type: 'image', data, mimeType }];
  if (note) content.unshift({ type: 'text', text: note });
  return { content };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveRemote(p: string, base: string): string {
  if (p.startsWith('/')) return p;
  // POSIX-style join; the remote host is assumed POSIX.
  return path.posix.join(base, p);
}

/** Default number of lines the built-in Read tool returns when no limit is given. */
const READ_DEFAULT_LIMIT = 2000;
/**
 * Mirror of the built-in Read tool's `<system-reminder>` placeholder for empty
 * files. The CLI uses this exact wording; matching it keeps the model's
 * reaction identical regardless of whether the file lives locally or remotely.
 */
const EMPTY_FILE_REMINDER =
  '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * `cat -n` style line numbering: 6-char right-aligned line number + tab +
 * content. This is the exact format the built-in Read tool returns, which the
 * Edit tool's description warns the model about ("preserve the exact
 * indentation … AFTER the line number prefix"). Matching it keeps prompts
 * portable between local and remote workspaces.
 */
function formatCatN(lines: string[], firstLineNumber: number): string {
  return lines
    .map((line, i) => `${String(firstLineNumber + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

async function sftpStat(
  sftp: SFTPWrapper,
  abs: string,
): Promise<{ size: number; mode: number; isFile: boolean; isDir: boolean }> {
  return new Promise((resolve, reject) => {
    sftp.stat(abs, (e, st) => {
      if (e || !st) {
        reject(e ?? new Error('stat failed'));
        return;
      }
      const t = st.mode & 0o170000;
      resolve({
        size: st.size,
        mode: st.mode,
        isFile: t === 0o100000,
        isDir: t === 0o040000,
      });
    });
  });
}

async function readRemoteText(sftp: SFTPWrapper, abs: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.readFile(abs, (e, data) => {
      if (e) reject(e);
      else resolve((data as Buffer).toString('utf8'));
    });
  });
}

async function readRemoteBinary(
  sftp: SFTPWrapper,
  abs: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(abs, (e, data) => {
      if (e) reject(e);
      else resolve(data as Buffer);
    });
  });
}

async function writeRemoteFile(
  sftp: SFTPWrapper,
  abs: string,
  content: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(abs, content, 'utf8', (e) => {
      if (e) reject(e);
      else resolve();
    });
  });
}

/**
 * Detect binary content the same way `grep -I` / git do — sniff for a NUL byte
 * in the first chunk. Plain UTF-8 text never contains NUL; binary blobs almost
 * always do. Used to refuse text-mode display of binaries the model couldn't
 * meaningfully consume anyway.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export type RemoteToolContext = {
  workspaceCwd: string; // ssh://...
};

export function createRemoteMcpServer(ctx: RemoteToolContext) {
  const parsed = parseCwd(ctx.workspaceCwd);
  if (parsed.kind !== 'ssh') {
    throw new Error('createRemoteMcpServer requires an ssh:// workspace cwd');
  }
  const ws = getWorkspace(ctx.workspaceCwd);
  const stored = getStoredSshPassword(ctx.workspaceCwd);
  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws?.sshIdentityPath ?? null,
    useAgent: ws?.sshUseAgent ?? false,
    expectedHostFingerprint: ws?.sshKnownHostFp ?? null,
    password: stored ?? undefined,
  };
  const baseDir = parsed.path;

  const host = (): Promise<RemoteHost> => getHost(opts);

  return createSdkMcpServer({
    name: 'remote',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'bash',
        `Execute a shell command on the remote SSH host (${parsed.user}@${parsed.host}). ` +
          `Runs in ${baseDir} unless an absolute cd is included. Streams stdout+stderr back. ` +
          `Use this instead of the built-in Bash tool — that one runs locally and won't see the remote files.`,
        {
          command: z.string().describe('Command to execute on the remote host'),
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
          const h = await host();
          const wrapped = `cd ${shellQuote(baseDir)} 2>/dev/null; ${args.command}`;
          const timeout = args.timeout_ms ?? 120_000;
          let timer: NodeJS.Timeout | null = null;
          let timedOut = false;
          const result = await Promise.race([
            h.exec(wrapped),
            new Promise<{
              stdout: string;
              stderr: string;
              code: number | null;
              signal: string | null;
            }>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve({
                  stdout: '',
                  stderr: `[timeout after ${timeout}ms]`,
                  code: 124,
                  signal: null,
                });
              }, timeout);
            }),
          ]);
          if (timer) clearTimeout(timer);
          const tail = `\n[exit ${result.code ?? '?'}${result.signal ? ` signal ${result.signal}` : ''}${timedOut ? ' — killed by host (timeout)' : ''}]`;
          const body = (result.stdout || '') + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '');
          return result.code === 0 ? ok(body + tail) : err(body + tail);
        },
      ),

      tool(
        'read',
        // Description mirrors the built-in Read tool's, retargeted at the
        // remote SSH filesystem. Same usage notes, same defaults, same
        // image-rendering promise — kept word-for-word so the model treats
        // local/remote reads identically.
        `Reads a file from the remote SSH filesystem (${parsed.user}@${parsed.host}). You can access any file on the remote host using this tool.
Assume this tool is able to read all files on the remote host. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter should be an absolute path; workspace-relative paths are resolved against ${baseDir}
- By default, it reads up to ${READ_DEFAULT_LIMIT} lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows reading images (eg PNG, JPG, GIF, WEBP) from the remote host. When reading an image file the contents are presented visually so you (the multimodal model) can see them.
- This tool can only read files, not directories. To list a directory, use the ls tool instead.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`,
        {
          file_path: z
            .string()
            .describe(
              'The absolute path to the file to read on the remote host',
            ),
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
          const h = await host();
          const sftp = await h.sftp();
          const abs = resolveRemote(args.file_path, baseDir);
          let stat;
          try {
            stat = await sftpStat(sftp, abs);
          } catch (e) {
            return err(
              `Failed to read ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
          if (stat.isDir) {
            return err(
              `${abs} is a directory. Use the ls tool to list directory contents.`,
            );
          }
          if (!stat.isFile) {
            return err(`${abs} is not a regular file`);
          }

          // ─ Image branch: return as a multimodal `image` content block so
          //   Claude can actually see the picture, matching the built-in
          //   Read tool's behavior for local images.
          const ext = path.posix.extname(abs).toLowerCase();
          const imageMime = IMAGE_MIME_BY_EXT[ext];
          if (imageMime) {
            try {
              const buf = await readRemoteBinary(sftp, abs);
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

          // ─ Text branch.
          let buf: Buffer;
          try {
            buf = await readRemoteBinary(sftp, abs);
          } catch (e) {
            return err(
              `Failed to read ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
          if (buf.length === 0) {
            return ok(EMPTY_FILE_REMINDER);
          }
          if (looksBinary(buf)) {
            return err(
              `${abs} appears to be a binary file (${stat.size} bytes). The remote read tool only renders text files and the supported image types (png, jpg, jpeg, gif, webp).`,
            );
          }
          const text = buf.toString('utf8');
          const allLines = text.split('\n');
          // Mirror cat -n: a file ending in "\n" produces a trailing empty
          // "line" via split; drop it so line counts match `wc -l` + 1.
          if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
            allLines.pop();
          }
          const totalLines = allLines.length;
          const startIdx = Math.max(0, (args.offset ?? 1) - 1);
          const limit = args.limit ?? READ_DEFAULT_LIMIT;
          const endIdx = Math.min(allLines.length, startIdx + limit);
          if (startIdx >= totalLines && totalLines > 0) {
            return ok(
              `(offset ${args.offset} is past the end of the file — total ${totalLines} lines)`,
            );
          }
          const slice = allLines.slice(startIdx, endIdx);
          const formatted = formatCatN(slice, startIdx + 1);
          let suffix = '';
          if (endIdx < totalLines) {
            suffix =
              `\n\n(... ${totalLines - endIdx} more line${
                totalLines - endIdx === 1 ? '' : 's'
              }. Pass offset=${endIdx + 1} to continue reading.)`;
          }
          return ok(formatted + suffix);
        },
      ),

      tool(
        'write',
        // Description mirrors the built-in Write tool's verbatim, retargeted
        // at the remote SSH filesystem. The "must Read first" rule, the
        // preference for Edit over rewriting, and the docs/emoji notes all
        // travel with it so behavior stays identical for the model.
        `Writes a file to the remote SSH filesystem (${parsed.user}@${parsed.host}).

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the remote read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the remote edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,
        {
          file_path: z
            .string()
            .describe(
              'The absolute path to the file to write on the remote host (must be absolute, not relative)',
            ),
          content: z.string().describe('The content to write to the file'),
        },
        async (args): Promise<ToolResult> => {
          const h = await host();
          const sftp = await h.sftp();
          const abs = resolveRemote(args.file_path, baseDir);
          try {
            // Ensure parent directory exists.
            const parent = path.posix.dirname(abs);
            if (parent && parent !== '/') {
              await h.exec(`mkdir -p ${shellQuote(parent)}`);
            }
            await writeRemoteFile(sftp, abs, args.content);
            return ok(`Wrote ${abs} (${args.content.length} bytes)`);
          } catch (e) {
            return err(
              `Failed to write ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
        },
      ),

      tool(
        'edit',
        // Description mirrors the built-in Edit tool's verbatim. The
        // line-number-prefix warning is critical: matching it ensures the
        // model strips the cat -n prefix correctly whether the file is local
        // or remote.
        `Performs exact string replacements in files on the remote SSH host (${parsed.user}@${parsed.host}).

Usage:
- You must use the remote read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
        {
          file_path: z
            .string()
            .describe('The absolute path to the file to modify'),
          old_string: z.string().describe('The text to replace'),
          new_string: z
            .string()
            .describe('The text to replace it with (must be different from old_string)'),
          replace_all: z
            .boolean()
            .optional()
            .describe('Replace all occurrences of old_string (default false)'),
        },
        async (args): Promise<ToolResult> => {
          const h = await host();
          const sftp = await h.sftp();
          const abs = resolveRemote(args.file_path, baseDir);
          try {
            const original = await readRemoteText(sftp, abs);
            if (args.old_string === args.new_string) {
              return err('new_string must be different from old_string');
            }
            const occurrences = original.split(args.old_string).length - 1;
            if (occurrences === 0) {
              return err(`old_string not found in ${abs}`);
            }
            if (occurrences > 1 && !args.replace_all) {
              return err(
                `old_string matches ${occurrences} times in ${abs}. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.`,
              );
            }
            const next = args.replace_all
              ? original.split(args.old_string).join(args.new_string)
              : original.replace(args.old_string, args.new_string);
            await writeRemoteFile(sftp, abs, next);
            const made = args.replace_all ? occurrences : 1;
            return ok(
              `Edited ${abs} (${made} replacement${made === 1 ? '' : 's'})`,
            );
          } catch (e) {
            return err(
              `Failed to edit ${abs}: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
          }
        },
      ),

      tool(
        'glob',
        `Find files on the remote host matching a glob pattern (e.g. **/*.ts).`,
        {
          pattern: z.string().describe('Glob pattern (supports **)'),
          path: z
            .string()
            .optional()
            .describe('Search root (default: workspace root)'),
        },
        async (args): Promise<ToolResult> => {
          const h = await host();
          const root = args.path ? resolveRemote(args.path, baseDir) : baseDir;
          // bash globstar handles **, then printf one path per line.
          const cmd =
            `bash -c 'shopt -s globstar nullglob dotglob; cd ${shellQuote(root)} && ` +
            `for f in ${args.pattern}; do printf "%s\\n" "$f"; done'`;
          const r = await h.exec(cmd);
          if (r.code !== 0) return err(r.stderr || `glob failed (exit ${r.code})`);
          const lines = r.stdout.split('\n').filter(Boolean);
          return ok(
            lines.length > 0
              ? lines.map((l) => path.posix.join(root, l)).join('\n')
              : '(no matches)',
          );
        },
      ),

      tool(
        'grep',
        `Search file contents on the remote host. Uses ripgrep (rg) when available, otherwise GNU grep.`,
        {
          pattern: z.string().describe('Regex pattern'),
          path: z.string().optional().describe('Search root (default: workspace root)'),
          glob: z.string().optional().describe('Glob to filter files (e.g. "*.ts")'),
          case_insensitive: z.boolean().optional(),
          context: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Lines of context around each match'),
          max_results: z.number().int().positive().optional(),
        },
        async (args): Promise<ToolResult> => {
          const h = await host();
          const root = args.path ? resolveRemote(args.path, baseDir) : baseDir;
          const haveRg = (await h.exec('command -v rg')).code === 0;
          const max = args.max_results ?? 200;
          let cmd: string;
          if (haveRg) {
            cmd = `rg --color=never -n`;
            if (args.case_insensitive) cmd += ' -i';
            if (args.context) cmd += ` -C ${args.context}`;
            if (args.glob) cmd += ` -g ${shellQuote(args.glob)}`;
            cmd += ` ${shellQuote(args.pattern)} ${shellQuote(root)}`;
            cmd += ` | head -n ${max}`;
          } else {
            cmd = `grep -RIn --color=never`;
            if (args.case_insensitive) cmd += ' -i';
            if (args.context) cmd += ` -C ${args.context}`;
            if (args.glob) cmd += ` --include=${shellQuote(args.glob)}`;
            cmd += ` ${shellQuote(args.pattern)} ${shellQuote(root)}`;
            cmd += ` | head -n ${max}`;
          }
          const r = await h.exec(cmd);
          if (r.code !== 0 && !r.stdout) {
            return ok('(no matches)');
          }
          return ok(r.stdout || '(no matches)');
        },
      ),

      tool(
        'ls',
        `List a directory on the remote host (long form, including hidden entries).`,
        {
          path: z.string().describe('Absolute or workspace-relative path on the remote host'),
        },
        async (args): Promise<ToolResult> => {
          const h = await host();
          const abs = resolveRemote(args.path, baseDir);
          const r = await h.exec(`ls -la --time-style=long-iso ${shellQuote(abs)}`);
          if (r.code !== 0) return err(r.stderr || `ls failed (exit ${r.code})`);
          return ok(r.stdout);
        },
      ),
    ],
  });
}
