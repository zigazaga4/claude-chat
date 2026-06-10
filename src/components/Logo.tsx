'use client';

import { cn } from '@/lib/cn';

type LogoProps = {
  className?: string;
  showWordmark?: boolean;
};

export default function Logo({ className, showWordmark = true }: LogoProps) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      <span className="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg bg-primary/15 ring-1 ring-primary/30">
        <CloudGlyph className="relative h-4 w-4 text-primary" />
      </span>
      {showWordmark && (
        <span className="text-sm font-semibold tracking-tight text-primary">
          claude chat
        </span>
      )}
    </div>
  );
}

export function CloudGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M7 18h10.5a4.5 4.5 0 0 0 .58-8.96 6 6 0 0 0-11.6.55A4.5 4.5 0 0 0 7 18z" />
    </svg>
  );
}
