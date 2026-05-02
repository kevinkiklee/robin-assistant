import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../lib/platforms.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export function generatePointers() {
  const out = {};
  for (const [name, p] of Object.entries(PLATFORMS)) {
    if (!p.pointerFile) continue;
    out[p.pointerFile] = p.pointerContent;
  }
  return out;
}

export function writePointers(targetDir = REPO_ROOT) {
  const files = generatePointers();
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(targetDir, name), content);
    console.log(`Wrote ${name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writePointers();
}
