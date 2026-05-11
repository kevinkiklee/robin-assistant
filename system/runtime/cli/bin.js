import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Returns the absolute path to the v2 bin/robin entry, regardless of whether
// v2 is dev-checkout or globally installed. Works because the file structure
// from src/runtime/bin.js to bin/robin is fixed.
export function resolveBinPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../bin/robin');
}
