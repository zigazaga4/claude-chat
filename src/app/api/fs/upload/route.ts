import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { NextRequest } from 'next/server';
import type { SFTPWrapper } from 'ssh2';
import { parseCwd } from '@/lib/cwd';
import { getHost, type ConnectOpts } from '@/server/sshHosts';
import { getStoredSshPassword, getWorkspace } from '@/server/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/fs/upload
 *
 * multipart/form-data fields:
 *   - cwd:  workspace root (local path OR ssh://user@host:port/path)
 *   - dest: absolute directory the files should land in (on the workspace's
 *           host — local FS for local workspaces, remote FS via SFTP for SSH)
 *   - files: one or more File entries
 *
 * Symmetric with /api/fs/tree + /api/fs/read so the FilesView can stay
 * workspace-agnostic. We deliberately don't enforce a server-side body cap
 * here — the user explicitly asked for size limits removed. The underlying
 * Node/SSH layer and the user's disk are the real ceilings.
 */

type UploadedItem = { name: string; path: string; size: number };

type UploadResponse = {
  ok: true;
  dest: string;
  uploaded: UploadedItem[];
  errors?: { name: string; error: string }[];
};

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? `Invalid multipart body: ${err.message}`
            : 'Invalid multipart body',
      },
      { status: 400 },
    );
  }

  const cwd = (form.get('cwd') ?? '').toString();
  const destRaw = (form.get('dest') ?? '').toString();
  const files = form
    .getAll('files')
    .filter((v): v is File => v instanceof File);

  if (!cwd) {
    return Response.json({ error: 'cwd field is required' }, { status: 400 });
  }
  if (!destRaw) {
    return Response.json({ error: 'dest field is required' }, { status: 400 });
  }
  if (files.length === 0) {
    return Response.json(
      { error: 'at least one `files` field is required' },
      { status: 400 },
    );
  }

  let parsed;
  try {
    parsed = parseCwd(cwd);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'invalid cwd' },
      { status: 400 },
    );
  }

  if (parsed.kind === 'local') {
    return handleLocal(destRaw, files);
  }
  return handleSsh(cwd, parsed, destRaw, files);
}

// ───────────────────────────── local ──────────────────────────────────────

async function handleLocal(
  destRaw: string,
  files: File[],
): Promise<Response> {
  const dest = path.resolve(destRaw);
  try {
    const stat = await fs.stat(dest);
    if (!stat.isDirectory()) {
      return Response.json(
        { error: 'dest is not a directory', dest },
        { status: 400 },
      );
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'dest not found', dest },
      { status: 400 },
    );
  }

  const uploaded: UploadedItem[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    const name = safeBasename(file.name);
    if (!name) {
      errors.push({ name: file.name, error: 'invalid filename' });
      continue;
    }
    const abs = path.join(dest, name);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(abs, buf);
      uploaded.push({ name, path: abs, size: buf.byteLength });
    } catch (err) {
      errors.push({
        name,
        error: err instanceof Error ? err.message : 'write failed',
      });
    }
  }

  const body: UploadResponse = {
    ok: true,
    dest,
    uploaded,
    ...(errors.length > 0 ? { errors } : {}),
  };
  return Response.json(body);
}

// ────────────────────────────── ssh ───────────────────────────────────────

async function handleSsh(
  cwd: string,
  parsed: Extract<ReturnType<typeof parseCwd>, { kind: 'ssh' }>,
  destRaw: string,
  files: File[],
): Promise<Response> {
  const ws = getWorkspace(cwd);
  if (!ws) {
    return Response.json({ error: 'workspace not found' }, { status: 404 });
  }
  const stored = getStoredSshPassword(cwd);
  const opts: ConnectOpts = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    identityPath: ws.sshIdentityPath,
    useAgent: ws.sshUseAgent,
    expectedHostFingerprint: ws.sshKnownHostFp,
    password: stored ?? undefined,
  };

  let host;
  try {
    host = await getHost(opts);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'connect failed' },
      { status: 502 },
    );
  }

  let dest = destRaw;
  if (dest === '~' || dest.startsWith('~')) {
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim() || '/';
    dest = dest === '~' ? home : home + dest.slice(1);
  }
  if (!dest.startsWith('/')) dest = '/' + dest;

  const sftp = await host.sftp();

  // Verify dest is a directory before we start streaming bytes — saves a
  // partial-write on a clearly-bad path.
  const destStat = await new Promise<{ mode: number } | { __error: string }>(
    (resolve) => {
      sftp.stat(dest, (err, st) => {
        if (err || !st) {
          resolve({ __error: err?.message ?? 'stat failed' });
        } else {
          resolve({ mode: st.mode });
        }
      });
    },
  );
  if ('__error' in destStat) {
    return Response.json(
      { error: destStat.__error, dest },
      { status: 400 },
    );
  }
  if ((destStat.mode & 0o170000) !== 0o040000) {
    return Response.json(
      { error: 'dest is not a directory', dest },
      { status: 400 },
    );
  }

  const uploaded: UploadedItem[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    const name = safeBasename(file.name);
    if (!name) {
      errors.push({ name: file.name, error: 'invalid filename' });
      continue;
    }
    const remotePath = path.posix.join(dest, name);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await sftpWrite(sftp, remotePath, buf);
      uploaded.push({ name, path: remotePath, size: buf.byteLength });
    } catch (err) {
      errors.push({
        name,
        error: err instanceof Error ? err.message : 'write failed',
      });
    }
  }

  const body: UploadResponse = {
    ok: true,
    dest,
    uploaded,
    ...(errors.length > 0 ? { errors } : {}),
  };
  return Response.json(body);
}

// ──────────────────────────── helpers ─────────────────────────────────────

/**
 * Strip any path bits the browser might've attached to `file.name` (some
 * browsers report `webkitRelativePath` style names). The destination is
 * caller-controlled; the filename never is.
 */
function safeBasename(raw: string): string {
  const trimmed = raw.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  if (!trimmed) return '';
  if (trimmed === '.' || trimmed === '..') return '';
  if (trimmed.includes('\0')) return '';
  return trimmed;
}

/**
 * Pump a Buffer to a remote path via SFTP. We use `createWriteStream` so the
 * library handles chunking — `writeFile` would also work but allocates a
 * temporary internal buffer for very large payloads.
 */
function sftpWrite(
  sftp: SFTPWrapper,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    stream.on('error', done);
    stream.on('close', () => done());
    stream.on('finish', () => done());
    stream.end(data);
  });
}
