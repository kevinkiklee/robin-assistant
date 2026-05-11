import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { robinHome } from '../../runtime/data-store.js';

export async function version() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '../../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  console.log(`robin-assistant ${pkg.version}`);
  console.log(`home: ${robinHome()}`);
}
