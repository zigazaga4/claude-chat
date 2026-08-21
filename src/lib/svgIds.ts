/**
 * Rewrites every id in an SVG so a second copy can be mounted alongside the
 * first without colliding.
 *
 * Mermaid prefixes most ids with its render id, but not all of them — sequence
 * diagrams emit bare `actor0` / `root-0`, so prefix-swapping the render id
 * alone still leaves duplicate ids in the document. This renames all of them,
 * along with every `#id` reference: `url(#…)` markers, `href="#…"` links, and
 * the `#render-id .cls` selectors in the diagram's own scoped <style>.
 *
 * Operates on the markup rather than through DOMParser because the SVG carries
 * foreignObject HTML that is not guaranteed to be well-formed XML, and a parse
 * error there would lose the whole diagram.
 */
export function namespaceSvgIds(markup: string, suffix: string): string {
  const ids = [...new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]
    .filter(Boolean)
    // Longest first, so that in a single pass `#a-node0` is consumed as itself
    // and never as the prefix `#a` followed by junk.
    .sort((a, b) => b.length - a.length);
  if (ids.length === 0) return markup;

  const alt = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return markup
    .replace(new RegExp(`\\sid="(${alt})"`, 'g'), (_, id) => ` id="${id}-${suffix}"`)
    .replace(new RegExp(`#(${alt})`, 'g'), (_, id) => `#${id}-${suffix}`);
}
