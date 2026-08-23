/** Installs the TypeScript resolve hook. See ts-resolve-hook.mjs. */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve-hook.mjs', pathToFileURL('./scripts/'));
