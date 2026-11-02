#!/usr/bin/env node
// Compiles the network-path probe (system/lib/power-auto/netpath.swift) to
// dist/lib/power-auto/netpath. macOS only, and only when swiftc is installed
// (Xcode Command Line Tools); anywhere else it skips, and the power monitor
// treats metered detection as unavailable.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = join(root, 'system', 'lib', 'power-auto', 'netpath.swift');
const out = join(root, 'dist', 'lib', 'power-auto', 'netpath');

if (platform() !== 'darwin') {
  console.log('netpath: not macOS, skipped');
  process.exit(0);
}
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
  console.log('netpath: up to date');
  process.exit(0);
}
try {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('swiftc', ['-O', src, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`netpath: built ${out}`);
} catch (err) {
  const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`netpath: swiftc unavailable or failed (${msg}); metered detection disabled`);
}
