import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importFrom } from '../../secrets/dotenv-io.js';

export async function secretsImport(argv) {
  const fromIdx = argv.indexOf('--from');
  const force = argv.includes('--force');
  if (fromIdx === -1 || !argv[fromIdx + 1]) {
    console.error('usage: robin secrets import --from <path-to-v1-user-data> [--force]');
    console.error('  Suggestion: --from ~/workspace/robin/robin-assistant/user-data');
    process.exit(1);
  }
  let src = argv[fromIdx + 1];
  if (!src.endsWith('.env')) {
    src = join(src, 'runtime', 'secrets', '.env');
  }
  if (!existsSync(src)) {
    console.error(`source not found: ${src}`);
    process.exit(1);
  }
  try {
    importFrom(src, { force });
    console.log(`imported secrets from ${src}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
