'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Code2, Expand, TriangleAlert } from 'lucide-react';
import type { Mermaid } from 'mermaid';
import DiagramLightbox from './DiagramLightbox';
import { mermaidConfig } from '@/lib/mermaidTheme';
import { cn } from '@/lib/cn';

/**
 * Renders a ```mermaid fenced block as a live diagram.
 *
 * Mermaid is ~3 MB with its layout engines, so it is pulled in through a
 * dynamic import the first time a diagram actually appears — a conversation
 * with no diagrams never pays for it. The import promise is cached at module
 * scope so N diagrams in one message share a single load and a single
 * `initialize()`.
 *
 * Diagram source comes from the model, so it can be wrong. A parse failure
 * degrades to the source in a code block rather than an exception or an empty
 * gap: the user still gets the content, just untransformed.
 */

let mermaidLoader: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then(({ default: mermaid }) => {
      // Read the live tokens once — mermaid holds config globally, and the app
      // forces dark, so there is no theme flip to track.
      const css = getComputedStyle(document.documentElement);
      const read = (name: string) => {
        const raw = css.getPropertyValue(name).trim();
        return raw ? `hsl(${raw})` : '';
      };
      mermaid.initialize(
        mermaidConfig(read, getComputedStyle(document.body).fontFamily),
      );
      return mermaid;
    });
  }
  return mermaidLoader;
}

export default function MermaidDiagram({ code }: { code: string }) {
  // Mermaid uses this as a DOM id and in its own querySelector calls, so the
  // colons React's useId() produces have to go.
  const reactId = useId();
  const domId = useMemo(() => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [reactId]);

  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [pending, setPending] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bindRef = useRef<((el: Element) => void) | null>(null);

  const source = code.trim();

  useEffect(() => {
    if (!source) return;
    let live = true;

    // Text can still be arriving (plan blocks stream through Markdown), and a
    // half-written diagram is a parse error. Coalescing at the frame level
    // keeps mid-stream failures off the screen without a visible lag once the
    // text settles.
    const timer = setTimeout(() => {
      loadMermaid()
        .then((mermaid) => mermaid.render(domId, source))
        .then(({ svg: rendered, bindFunctions }) => {
          if (!live) return;
          bindRef.current = bindFunctions ?? null;
          setSvg(rendered);
          setError(null);
          setPending(false);
        })
        .catch((err: unknown) => {
          if (!live) return;
          // Mermaid can leave its scratch node behind on a throw.
          document.getElementById(`d${domId}`)?.remove();
          setError(err instanceof Error ? err.message : String(err));
          setPending(false);
        });
    }, 120);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, domId]);

  // Flowchart tooltips are wired up by mermaid after the SVG is in the DOM.
  useEffect(() => {
    if (svg && bindRef.current && hostRef.current) bindRef.current(hostRef.current);
  }, [svg]);

  if (!source) return null;

  // A failure with nothing previously rendered is a real failure; a failure on
  // top of a good render is almost always half-arrived text, so the last good
  // diagram stays up instead of flashing an error at the user.
  const failed = error != null && !svg;

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-md border',
        failed ? 'border-amber-400/30 bg-amber-500/[0.06]' : 'border-border/60 bg-card/50',
      )}
    >
      {failed ? (
        <div className="flex items-start gap-1.5 px-3 pt-2 text-[10px] uppercase tracking-wide text-amber-200/80">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">Diagram failed to parse — showing source</span>
        </div>
      ) : (
        <div className="flex items-center gap-1 px-3 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            aria-expanded={showSource}
            title={showSource ? 'Hide diagram source' : 'Show diagram source'}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-foreground"
          >
            <Code2 className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {showSource ? 'Hide source' : 'Diagram'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            disabled={!svg}
            title="Expand to full screen"
            className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground disabled:opacity-30"
          >
            <Expand className="h-3 w-3" />
          </button>
        </div>
      )}

      {!failed && (
        <div
          ref={hostRef}
          onDoubleClick={() => svg && setExpanded(true)}
          // Mermaid stamps an inline max-width on the <svg>; override it so wide
          // diagrams scroll inside the card instead of overflowing the message.
          className={cn(
            'overflow-x-auto px-3 py-2 text-center [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full',
            pending && 'min-h-8 animate-pulse',
            svg && 'cursor-zoom-in',
          )}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {(failed || showSource) && (
        <pre className="overflow-x-auto border-t border-border/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
          {source}
        </pre>
      )}

      {failed && (
        <p className="border-t border-border/40 px-3 py-1.5 font-mono text-[10.5px] text-amber-200/60">
          {error}
        </p>
      )}

      {expanded && svg && <DiagramLightbox svg={svg} onClose={() => setExpanded(false)} />}
    </div>
  );
}
