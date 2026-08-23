/**
 * Resolve hook that lets plain `node --experimental-strip-types` run this
 * project's TypeScript directly.
 *
 * Two things Node cannot do on its own here: extensionless relative imports
 * (`./db` meaning `./db.ts`), and the `@/` alias that only tsconfig knows
 * about. Both are resolved by rewriting the specifier before Node sees it.
 *
 * Used by the ad-hoc verification scripts, not by the app.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const SRC = pathToFileURL(path.join(process.cwd(), 'src') + path.sep).href;

export async function resolve(specifier, context, next) {
  let spec = specifier;

  if (spec.startsWith('@/')) spec = new URL(spec.slice(2), SRC).href;

  if (spec.startsWith('.') || spec.startsWith('file:')) {
    const base = spec.startsWith('.')
      ? new URL(spec, context.parentURL).href
      : spec;
    if (!/\.[cm]?[jt]sx?$/.test(base)) {
      for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (fs.existsSync(new URL(candidate))) return next(candidate, context);
      }
    }
    return next(base, context);
  }

  return next(spec, context);
}
