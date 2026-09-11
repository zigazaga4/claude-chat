/**
 * The one Prism instance every highlighter in the app draws from.
 *
 * prism-react-renderer bundles a vendored core with ~25 grammars, well short
 * of what `fileIcons.ts` claims to recognise: csharp, bash, powershell, php,
 * toml, docker and twenty more render as plain text without this module. The
 * grammar files ship in the `prismjs` package and register on whatever
 * `globalThis.Prism` is when they execute; `./prismGlobal` points that at the
 * vendored core, and MUST stay the first import here (see the note there).
 *
 * Import `Highlight` / `CODE_THEME` from this module rather than from
 * 'prism-react-renderer' directly. Importing this module is what loads the
 * grammars — a view that bypasses it silently gets plain text for half the
 * languages, with nothing to say why.
 *
 * The list is exactly the set `fileIcons.ts` maps that the vendored core
 * lacks: ~54 KB minified, ~15 KB over the wire. Two entries have
 * prerequisites — `php` needs `markup-templating`, `scala` needs `java` — and
 * the order below honours that. Unknown languages are harmless: Highlight
 * renders the code as a single plain token, so a new fileIcons entry without
 * a grammar here degrades to uncoloured text rather than breaking.
 */
import './prismGlobal';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-batch';
import 'prismjs/components/prism-clojure';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-elixir';
import 'prismjs/components/prism-erlang';
import 'prismjs/components/prism-groovy';
import 'prismjs/components/prism-haskell';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-latex';
import 'prismjs/components/prism-less';
import 'prismjs/components/prism-lisp';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-ocaml';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-sass';
import 'prismjs/components/prism-scala';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-toml';

import { Highlight, Prism, themes } from 'prism-react-renderer';

export { Highlight, Prism, themes };
export type { Token, TokenOutputProps } from 'prism-react-renderer';

/**
 * The single code colour scheme. Both the file viewer and tool-call diffs use
 * it, so a line of code looks the same wherever it appears.
 *
 * Note for consumers rendering tokens by hand: `getTokenProps` attaches NO
 * style to a `plain` token — it inherits its parent's colour. The theme's
 * `plain.color` only reaches the text via the container style that
 * `<Highlight>` hands back, so a view that doesn't spread that style onto its
 * wrapper must set `CODE_THEME.plain.color` on the text itself, or
 * identifiers and whitespace come out in whatever the surrounding UI colour is.
 */
export const CODE_THEME = themes.vsDark;
