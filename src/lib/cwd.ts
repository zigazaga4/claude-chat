/**
 * Workspace cwd may be either a real local path ("/home/leo/projects/x")
 * or an SSH URI ("ssh://user@host:port/path"). All routes / UI go through
 * this helper so the encoding stays consistent.
 */

export type ParsedCwd =
  | { kind: 'local'; path: string; raw: string }
  | {
      kind: 'ssh';
      user: string;
      host: string;
      port: number;
      path: string;
      raw: string;
    };

export function parseCwd(raw: string): ParsedCwd {
  if (raw.startsWith('ssh://')) {
    // ssh://user@host:port/path  (port optional)
    const rest = raw.slice('ssh://'.length);
    const slashIdx = rest.indexOf('/');
    const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const path = slashIdx >= 0 ? rest.slice(slashIdx) : '';
    const atIdx = authority.lastIndexOf('@');
    if (atIdx < 0) {
      throw new Error(`Invalid SSH cwd (missing user): ${raw}`);
    }
    const user = authority.slice(0, atIdx);
    const hostPort = authority.slice(atIdx + 1);
    const colonIdx = hostPort.lastIndexOf(':');
    const host = colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort;
    const port =
      colonIdx >= 0 ? Number(hostPort.slice(colonIdx + 1)) || 22 : 22;
    return {
      kind: 'ssh',
      user,
      host,
      port,
      path: path || '~',
      raw,
    };
  }
  return { kind: 'local', path: raw, raw };
}

export function buildSshCwd(opts: {
  user: string;
  host: string;
  port?: number;
  path: string;
}): string {
  const port = opts.port && opts.port !== 22 ? `:${opts.port}` : '';
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  return `ssh://${opts.user}@${opts.host}${port}${path}`;
}

export function isSshCwd(raw: string): boolean {
  return raw.startsWith('ssh://');
}

/** Pretty short label for sidebar — basename of path, or host for SSH. */
export function shortLabel(raw: string): string {
  const p = parseCwd(raw);
  if (p.kind === 'ssh') {
    const base = p.path.replace(/\/$/, '');
    const lastSlash = base.lastIndexOf('/');
    const tail = lastSlash >= 0 ? base.slice(lastSlash + 1) || '/' : base;
    return `${tail || '~'} @ ${p.host}`;
  }
  const trimmed = p.path.replace(/\/$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}
