import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Entry = { name: string; path: string };

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requested = url.searchParams.get('path');
  const target = path.resolve(requested && requested.length > 0 ? requested : os.homedir());

  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      return Response.json({ error: 'Not a directory', path: target }, { status: 400 });
    }
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries: Entry[] = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(target);
    return Response.json({
      path: target,
      parent: parent === target ? null : parent,
      home: os.homedir(),
      entries,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message, path: target }, { status: 400 });
  }
}
