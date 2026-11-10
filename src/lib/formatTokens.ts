/**
 * Short human form of a token count: `950`, `12.5k`, `300k`, `1.2M`.
 *
 * One definition for every place a token count is shown in a pill, ring or
 * divider, so the same number never reads two ways on the same screen.
 */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `${n}`;
}
