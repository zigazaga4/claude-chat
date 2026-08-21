'use client';

import { Children, isValidElement, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MermaidDiagram from './MermaidDiagram';
import { cn } from '@/lib/cn';

type MarkdownProps = {
  children: string;
  className?: string;
};

type CodeProps = ComponentProps<'code'> & { inline?: boolean };

/** Flatten a rendered subtree back to its text. Fenced code arrives as a lone
 *  string, but highlighters and plugins can split it across nodes. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

/**
 * A ```mermaid fence, if that is what this <pre> wraps.
 *
 * The swap happens at `pre` rather than at `code` because the diagram replaces
 * the whole code-block shell — returning a <div> from `code` would leave it
 * nested inside a styled <pre>, which is both invalid nesting and a border
 * drawn around a diagram that already has one.
 */
function mermaidSource(children: ReactNode): string | null {
  const [child] = Children.toArray(children);
  if (!isValidElement(child)) return null;
  const { className } = child.props as { className?: string };
  if (!/(?:^|\s)language-mermaid(?:$|\s)/.test(className ?? '')) return null;
  return nodeText((child.props as { children?: ReactNode }).children);
}

const components = {
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mt-2 mb-2 text-base font-semibold">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-2 mb-2 text-sm font-semibold">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-blue-400/50 pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border/60" />,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border border-border/60 bg-muted/40 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border border-border/60 px-2 py-1 align-top">{children}</td>
  ),
  pre: ({ children }: { children?: ReactNode }) => {
    const diagram = mermaidSource(children);
    if (diagram !== null) return <MermaidDiagram code={diagram} />;
    return (
      <pre className="my-2 overflow-x-auto rounded-md border border-border/60 bg-background/80 p-3 text-xs leading-relaxed">
        {children}
      </pre>
    );
  },
  code: ({ inline, className, children, ...rest }: CodeProps) => {
    const text = String(children ?? '');
    const isBlock = !inline && /\n/.test(text);
    if (isBlock) {
      return (
        <code className={cn('font-mono text-[12.5px]', className)} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          'rounded border border-border/60 bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]',
          className,
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
};

export default function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn('break-words text-sm leading-relaxed', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
