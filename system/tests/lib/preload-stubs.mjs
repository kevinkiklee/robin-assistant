import { readFileSync, existsSync } from 'node:fs';
import { installStubs } from './stubs.js';

if (process.env.ROBIN_STUBS_FILE && existsSync(process.env.ROBIN_STUBS_FILE)) {
  const spec = JSON.parse(readFileSync(process.env.ROBIN_STUBS_FILE, 'utf8'));
  // RegExp matchers need rehydration when shipped via JSON — phase 1 supports
  // string-only matchers in subprocess scenarios. RegExp matchers work in inproc
  // mode. Subprocess RegExp support is a phase-2+ enhancement if needed.
  installStubs(spec);
}
