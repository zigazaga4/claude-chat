'use client';

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Loader2, Terminal as TerminalIcon } from 'lucide-react';
import { useInstances } from '@/state/instances';

type StartResp = { shellId: string; cwd: string; shell: string };

export default function ShellView() {
  const { active, patch } = useInstances();
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    aborted: boolean;
    term?: import('@xterm/xterm').Terminal;
    fit?: import('@xterm/addon-fit').FitAddon;
    es?: EventSource;
    inputAbort?: AbortController;
    onResize?: () => void;
    resizeObs?: ResizeObserver;
  }>({ aborted: false });
  const [status, setStatus] = useState<'idle' | 'starting' | 'connected' | 'exited' | 'error'>(
    'idle',
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const cwd = active.cwd;
  const instanceId = active.id;
  const desiredShellId =
    active.shellCwd === cwd ? active.shellId : null; // discard if cwd drifted

  useEffect(() => {
    let mounted = true;
    const s = stateRef.current;
    s.aborted = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErrorMsg(null);

    if (!cwd || !containerRef.current) return;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (!mounted || s.aborted) return;

      const term = new Terminal({
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: {
          background: '#0b0d12',
          foreground: '#e7e9ee',
          cursor: '#7dd3fc',
          cursorAccent: '#0b0d12',
          selectionBackground: '#3b4252',
          black: '#1d2026',
          red: '#f87171',
          green: '#86efac',
          yellow: '#fcd34d',
          blue: '#7dd3fc',
          magenta: '#d8b4fe',
          cyan: '#67e8f9',
          white: '#e7e9ee',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      const el = containerRef.current;
      if (!el) return;
      term.open(el);
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      s.term = term;
      s.fit = fit;

      // Start (or attach to) the pty session.
      let shellId = desiredShellId;
      if (!shellId) {
        setStatus('starting');
        try {
          const res = await fetch('/api/shell/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cwd,
              cols: term.cols,
              rows: term.rows,
            }),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(txt || `HTTP ${res.status}`);
          }
          const data = (await res.json()) as StartResp;
          shellId = data.shellId;
          patch(instanceId, { shellId, shellCwd: cwd });
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to start shell');
          setStatus('error');
          return;
        }
      }
      if (!mounted || s.aborted || !shellId) return;

      // Open SSE stream for output.
      const es = new EventSource(
        `/api/shell/stream?shellId=${encodeURIComponent(shellId)}`,
      );
      s.es = es;
      es.addEventListener('data', (ev) => {
        try {
          const { d } = JSON.parse((ev as MessageEvent).data) as { d: string };
          term.write(d);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('exit', (ev) => {
        try {
          const { code, signal } = JSON.parse((ev as MessageEvent).data) as {
            code: number | null;
            signal: number | null;
          };
          term.write(
            `\r\n\x1b[2m[shell exited${code != null ? ` code=${code}` : ''}${signal != null ? ` signal=${signal}` : ''}]\x1b[0m\r\n`,
          );
        } catch {
          /* ignore */
        }
        setStatus('exited');
        patch(instanceId, { shellId: null, shellCwd: null });
        es.close();
      });
      es.onopen = () => setStatus('connected');
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setStatus((cur) => (cur === 'exited' ? cur : 'error'));
        }
      };

      // Forward keystrokes to the shell.
      term.onData((data) => {
        const ac = new AbortController();
        s.inputAbort?.abort();
        s.inputAbort = ac;
        void fetch('/api/shell/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shellId, data }),
          signal: ac.signal,
        }).catch(() => {
          /* ignore — likely just a superseded request */
        });
      });

      // Re-fit on container resize and tell the pty about it.
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const doResize = () => {
        if (!s.fit || !s.term) return;
        try {
          s.fit.fit();
        } catch {
          return;
        }
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          void fetch('/api/shell/resize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shellId,
              cols: s.term!.cols,
              rows: s.term!.rows,
            }),
          }).catch(() => {});
        }, 80);
      };
      const ro = new ResizeObserver(doResize);
      ro.observe(el);
      window.addEventListener('resize', doResize);
      s.onResize = doResize;
      s.resizeObs = ro;
      // initial fit after attach (some layouts settle a tick after open)
      requestAnimationFrame(doResize);

      term.focus();
    })();

    return () => {
      mounted = false;
      s.aborted = true;
      try {
        s.es?.close();
      } catch {
        /* ignore */
      }
      try {
        s.resizeObs?.disconnect();
      } catch {
        /* ignore */
      }
      if (s.onResize) window.removeEventListener('resize', s.onResize);
      try {
        s.term?.dispose();
      } catch {
        /* ignore */
      }
      stateRef.current = { aborted: false };
    };
    // We intentionally re-run only when the workspace, instance, or which
    // shell to attach to changes — not on every patch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, instanceId, desiredShellId]);

  // If active.cwd changes while a shell exists for the old cwd, kill it so
  // the next mount starts a fresh shell in the new directory.
  useEffect(() => {
    if (!active.shellId) return;
    if (active.shellCwd && active.shellCwd !== cwd) {
      const stale = active.shellId;
      patch(active.id, { shellId: null, shellCwd: null });
      void fetch('/api/shell/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shellId: stale }),
      }).catch(() => {});
    }
  }, [cwd, active.shellId, active.shellCwd, active.id, patch]);

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Select a workspace to open a shell.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0b0d12]">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-card/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <TerminalIcon className="h-3 w-3 text-emerald-400" />
          <span className="truncate font-mono">{cwd}</span>
        </div>
        <StatusBadge status={status} error={errorMsg} />
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

function StatusBadge({
  status,
  error,
}: {
  status: 'idle' | 'starting' | 'connected' | 'exited' | 'error';
  error: string | null;
}) {
  if (status === 'starting' || status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-blue-300">
        <Loader2 className="h-3 w-3 animate-spin" />
        starting
      </span>
    );
  }
  if (status === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        live
      </span>
    );
  }
  if (status === 'exited') {
    return <span className="text-muted-foreground">exited</span>;
  }
  return (
    <span className="text-red-400" title={error ?? undefined}>
      error
    </span>
  );
}
