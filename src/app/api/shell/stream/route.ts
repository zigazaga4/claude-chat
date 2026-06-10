import type { NextRequest } from 'next/server';
import { getSession } from '@/server/shellSessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENC = new TextEncoder();

function sseEvent(name: string, data: string): Uint8Array {
  // SSE data lines must not contain literal newlines; split into multiple
  // `data:` lines to preserve them across the wire.
  const safe = data.split('\n').map((l) => `data: ${l}`).join('\n');
  return ENC.encode(`event: ${name}\n${safe}\n\n`);
}

function sseRaw(name: string, payload: object): Uint8Array {
  return sseEvent(name, JSON.stringify(payload));
}

export async function GET(req: NextRequest) {
  const shellId = req.nextUrl.searchParams.get('shellId');
  if (!shellId) {
    return Response.json({ error: 'shellId required' }, { status: 400 });
  }
  const session = getSession(shellId);
  if (!session) {
    return Response.json({ error: 'shell not found' }, { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let hb: ReturnType<typeof setInterval> | null = null;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const onData = (chunk: string) => safeEnqueue(sseRaw('data', { d: chunk }));
      const onExit = (code: number | null, signal: number | null) => {
        safeEnqueue(sseRaw('exit', { code, signal }));
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (hb) clearInterval(hb);
        session.subscribers.delete(onData);
        session.exitSubscribers.delete(onExit);
      };

      // Replay scrollback so the client can render what it missed.
      if (session.scrollback) {
        safeEnqueue(sseRaw('data', { d: session.scrollback }));
      }

      session.subscribers.add(onData);
      session.exitSubscribers.add(onExit);

      // If the shell has already exited (and we're attaching late), flush
      // exit notice immediately.
      if (session.exited) {
        safeEnqueue(
          sseRaw('exit', { code: session.exitCode, signal: session.exitSignal }),
        );
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        return;
      }

      // Heartbeat — keeps proxies from dropping idle SSE connections.
      hb = setInterval(() => safeEnqueue(ENC.encode(`: hb\n\n`)), 25_000);

      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
