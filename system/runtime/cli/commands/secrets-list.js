import { existsSync, statSync } from 'node:fs';
import { envFilePath, listKeys } from '../../secrets/dotenv-io.js';

export async function secretsList() {
  const path = envFilePath();
  if (!existsSync(path)) {
    console.log(`(no secrets file at ${path})`);
    return;
  }
  const keys = listKeys();
  console.log(
    `${path} (${statSync(path).size} bytes, modified ${statSync(path).mtime.toISOString()})`,
  );
  if (keys.length === 0) {
    console.log('  (empty)');
    return;
  }
  for (const key of keys.sort()) {
    console.log(`  ${key}`);
  }
}
