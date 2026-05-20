#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// Build all user-data extensions (integrations + jobs) in one pass.
// Compiles each *.ts (excluding *.test.ts) to *.js, rewriting relative `.ts`
// imports to `.js` so the compiled output resolves under the dist daemon.
//
// Usage: pnpm build:extensions
import { build } from 'esbuild';

const ROOT = new URL('../', import.meta.url).pathname;
const ROOTS = [
  join(ROOT, 'user-data', 'extensions', 'integrations'),
  join(ROOT, 'user-data', 'extensions', 'jobs'),
];

const sources = [];
for (const root of ROOTS) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue;
      sources.push(join(dir, f));
    }
  }
}

if (sources.length === 0) {
  console.log('No extension sources found');
  process.exit(0);
}

const groups = new Map();
for (const src of sources) {
  const outdir = src.substring(0, src.lastIndexOf('/'));
  if (!groups.has(outdir)) groups.set(outdir, []);
  groups.get(outdir).push(src);
}

const rewriteTsToJs = {
  name: 'rewrite-ts-to-js',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      let src = await readFile(args.path, 'utf8');
      src = src.replace(
        /(from\s+['"])(\.\.?\/[^'"]*?)\.ts(['"])/g,
        (_m, pre, path, post) => `${pre}${path}.js${post}`,
      );
      return { contents: src, loader: 'ts' };
    });
  },
};

let totalCount = 0;
for (const [outdir, entryPoints] of groups) {
  await build({
    entryPoints,
    outdir,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: false,
    sourcemap: false,
    plugins: [rewriteTsToJs],
  });
  totalCount += entryPoints.length;
}

console.log(`Built ${totalCount} extension file(s) across ${groups.size} dir(s)`);
