import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function version() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '../../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  console.log(`robin-assistant ${pkg.version}`);
}
