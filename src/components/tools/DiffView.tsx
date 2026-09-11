'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { languageForPath } from '@/lib/fileIcons';
import { CODE_THEME, Highlight, type Token, type TokenOutputProps } from '@/lib/prism';
import { lineDiff, withContext, type DiffLine } from './diff';

type Props = {
  prior: string;
  next: string;
  /** When set, collapse unchanged stretches further than `context` lines from a change. */
  context?: number;
  /** Tailwind max-height class. Default `max-h-96`. */
  maxHeight?: string;
  /**
   * Path of the file being diffed. Picks the syntax grammar by extension;
   * without it the diff renders as uncoloured text.
   */
  path?: string;
};

/**
 * Past this much input (prior + next, in characters) the diff renders without
 * syntax colour. Tokenising is cheap; the DOM is not — every token becomes a
 * span, and the largest Write cards already push ~15k nodes as plain text.
 * Roughly two 100 KB files; ordinary edits never get near it.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;

type GetTokenProps = (input: { token: Token }) => TokenOutputProps;

export function DiffView({ prior, next, context, maxHeight = 'max-h-96', path }: Props) {
  const lines = useMemo(() => {
    const all = lineDiff(prior, next);
    return context != null ? withContext(all, context) : all;
  }, [prior, next, context]);

  const language =
    path && prior.length + next.length <= MAX_HIGHLIGHT_CHARS ? languageForPath(path) : 'text';
  const highlighted = language !== 'text';

  // Both sides are tokenised as whole documents rather than line by line, so
  // a block comment or template literal that straddles a hunk boundary keeps
  // its colour instead of being re-lexed from a cold start on every row. Each
  // row then picks its own line out of whichever side it came from: a
  // deletion is a line of `prior`, everything else is a line of `next`.
  //
  // Nested because Highlight is render-prop only. getTokenProps is a pure
  // theme lookup on the token's types, identical for either side, so the
  // inner one serves both.
  return (
    <Highlight code={prior} language={language} theme={CODE_THEME}>
      {({ tokens: priorTokens }) => (
        <Highlight code={next} language={language} theme={CODE_THEME}>
          {({ tokens: nextTokens, getTokenProps }) => (
            <div
              className={cn(
                'scrollbar-thin overflow-auto rounded-md border border-border/40 bg-background/70 font-mono text-[11.5px] leading-relaxed',
                maxHeight,
              )}
            >
              {/*
               * Sized to the widest line, never narrower than the viewport.
               * Rows fill it, so an added/removed line keeps its tint all
               * the way across when the user scrolls right instead of the
               * colour stopping at the original viewport edge.
               */}
              <div className="w-max min-w-full">
                {lines.map((l, i) => (
                  <DiffRow
                    key={i}
                    line={l}
                    tokens={highlighted ? tokensFor(l, priorTokens, nextTokens) : undefined}
                    getTokenProps={getTokenProps}
                  />
                ))}
              </div>
            </div>
          )}
        </Highlight>
      )}
    </Highlight>
  );
}

/**
 * The tokenised form of a diff row, from the side it belongs to. Undefined
 * for gap markers and for any index the tokeniser did not produce — the row
 * then falls back to its raw text, so a line-count mismatch between the diff
 * and the lexer can only ever cost colour, never content.
 */
function tokensFor(
  line: DiffLine,
  priorTokens: Token[][],
  nextTokens: Token[][],
): Token[] | undefined {
  if (line.kind === 'gap') return undefined;
  if (line.kind === 'del') {
    return line.oldNo != null ? priorTokens[line.oldNo - 1] : undefined;
  }
  return line.newNo != null ? nextTokens[line.newNo - 1] : undefined;
}

function DiffRow({
  line,
  tokens,
  getTokenProps,
}: {
  line: DiffLine;
  tokens?: Token[];
  getTokenProps: GetTokenProps;
}) {
  if (line.kind === 'gap') {
    return (
      <div className="flex items-center border-y border-border/30 bg-muted/20 text-[10.5px] text-muted-foreground/60">
        <span className="inline-block w-10 shrink-0 select-none border-r border-border/30 px-1.5 text-right tabular-nums">
          ⋯
        </span>
        <span className="inline-block w-10 shrink-0 select-none border-r border-border/30 px-1.5 text-right tabular-nums">
          ⋯
        </span>
        <span className="inline-block w-5 shrink-0 select-none border-r border-border/30 text-center">
          ⋯
        </span>
        <span className="px-2 italic">
          {line.gapSize} unchanged line{line.gapSize === 1 ? '' : 's'}
        </span>
      </div>
    );
  }

  const isAdd = line.kind === 'add';
  const isDel = line.kind === 'del';

  // With syntax colour the tokens carry their own text colours, and the row
  // tint plus gutter are what say added / removed — the way every code-aware
  // diff view does it. The green/red TEXT is only for the uncoloured path,
  // where it is the sole signal on the line itself.
  return (
    <div
      className={cn(
        'flex whitespace-pre',
        isAdd && 'bg-emerald-500/10',
        isDel && 'bg-red-500/10',
        !tokens && isAdd && 'text-emerald-200',
        !tokens && isDel && 'text-red-300',
        !tokens && line.kind === 'keep' && 'text-muted-foreground/80',
      )}
    >
      <span
        className={cn(
          'inline-block w-10 shrink-0 select-none border-r border-border/30 px-1.5 text-right tabular-nums',
          isAdd && 'bg-emerald-500/15 text-emerald-300/60',
          isDel && 'bg-red-500/20 text-red-300/80',
          line.kind === 'keep' && 'text-muted-foreground/40',
        )}
      >
        {line.oldNo ?? ''}
      </span>
      <span
        className={cn(
          'inline-block w-10 shrink-0 select-none border-r border-border/30 px-1.5 text-right tabular-nums',
          isAdd && 'bg-emerald-500/20 text-emerald-300/80',
          isDel && 'bg-red-500/15 text-red-300/60',
          line.kind === 'keep' && 'text-muted-foreground/40',
        )}
      >
        {line.newNo ?? ''}
      </span>
      <span
        className={cn(
          'inline-block w-5 shrink-0 select-none border-r border-border/30 text-center',
          isAdd && 'bg-emerald-500/20 text-emerald-300',
          isDel && 'bg-red-500/20 text-red-300',
          line.kind === 'keep' && 'text-muted-foreground/40',
        )}
      >
        {isAdd ? '+' : isDel ? '-' : ' '}
      </span>
      {tokens ? (
        // Plain tokens get no colour from getTokenProps (they inherit), so
        // the span sets the theme's plain colour itself — the same colour
        // FilesView gets from spreading Highlight's container style. Context
        // lines are dimmed so the change reads first.
        <span
          className={cn('px-2', line.kind === 'keep' && 'opacity-70')}
          style={{ color: CODE_THEME.plain.color }}
        >
          {tokens.map((token, j) => (
            <span key={j} {...getTokenProps({ token })} />
          ))}
        </span>
      ) : (
        <span className="px-2">{line.text || ' '}</span>
      )}
    </div>
  );
}
