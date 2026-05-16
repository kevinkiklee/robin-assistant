import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion = null;

export async function getCliVersion() {
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '../../../package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  cachedVersion = pkg.version;
  return cachedVersion;
}
