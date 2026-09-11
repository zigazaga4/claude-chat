/**
 * Publishes prism-react-renderer's vendored Prism core as the global that the
 * `prismjs/components/*` grammar files register themselves on.
 *
 * This lives in its own module purely for evaluation order. ESM hoists every
 * import and evaluates them, in source order, before any statement in the
 * importing module runs — so an assignment placed as a statement next to the
 * grammar imports would execute AFTER them, and each grammar would throw on a
 * missing `Prism`. Listing `import './prismGlobal'` ahead of the grammar
 * imports in prism.ts is what guarantees the global exists when they load.
 */
import { Prism } from 'prism-react-renderer';

(globalThis as { Prism?: unknown }).Prism = Prism;
