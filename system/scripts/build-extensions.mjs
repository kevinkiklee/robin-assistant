#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile, cp, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
// Build all user-data extensions (integrations + jobs) in one pass.
// Compiles each *.ts (excluding *.test.ts) to *.js, rewriting relative `.ts`
// imports to `.js` so the compiled output resolves under the dist daemon.
//
// Usage: pnpm build:extensions
import { build } from 'esbuild';

// This script lives at system/scripts/ — repo root is two levels up.
const ROOT = new URL('../../', import.meta.url).pathname;
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
    // `_`-prefixed dirs are sibling helpers (e.g. `_shared/`) — compiled so
    // integrations can import from them, but the runtime loader skips them as
    // integrations themselves. Hidden dirs (`.foo`) are always skipped.
    if (entry.startsWith('.')) continue;
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

// Builtin integrations and jobs ship via the published npm package — but tsc only
// emits .js/.d.ts, so `integration.yaml` / `job.yaml` manifests don't reach `dist/`
// without explicit copy. The runtime loader skips any dir missing a manifest, which
// silently disables every builtin. Mirror system/{integrations,jobs}/builtin/**/*.yaml
// into the matching dist tree so the loader can find them.
const MANIFEST_MIRRORS = [
  {
    from: join(ROOT, 'system', 'integrations', 'builtin'),
    to: join(ROOT, 'dist', 'integrations', 'builtin'),
  },
  { from: join(ROOT, 'system', 'jobs', 'builtin'), to: join(ROOT, 'dist', 'jobs', 'builtin') },
];

let manifestsCopied = 0;
for (const { from, to } of MANIFEST_MIRRORS) {
  let dirs;
  try {
    dirs = readdirSync(from);
  } catch {
    continue;
  }
  for (const d of dirs) {
    const srcDir = join(from, d);
    if (!statSync(srcDir).isDirectory()) continue;
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.yaml')) continue;
      const srcPath = join(srcDir, f);
      const dstPath = join(to, d, f);
      mkdirSync(dirname(dstPath), { recursive: true });
      await copyFile(srcPath, dstPath);
      manifestsCopied++;
    }
  }
}
if (manifestsCopied > 0) {
  console.log(`Mirrored ${manifestsCopied} builtin manifest(s) to dist/`);
}

// Builtin skills are markdown (+ optional bundled reference/scripts), never
// compiled — tsc won't emit them. Mirror the whole tree into dist so the skills
// loader (and the `skill` MCP tool) resolve `dist/skills/builtin` at runtime.
const SKILLS_FROM = join(ROOT, 'system', 'skills', 'builtin');
const SKILLS_TO = join(ROOT, 'dist', 'skills', 'builtin');
if (existsSync(SKILLS_FROM)) {
  await cp(SKILLS_FROM, SKILLS_TO, { recursive: true });
  console.log(`Mirrored builtin skills to ${relative(ROOT, SKILLS_TO)}`);
}

// chmod +x the CLI binary. Without this, Claude Code's MCP loader can't spawn
// `dist/surfaces/cli/index.js` directly — exec() fails with EACCES and the
// robin / robin-extension MCP servers show up as "Failed" in claude-mcp probes.
// npm/pnpm publish-time install sets this automatically via the `bin` field;
// in local dev (tsc-only) the bit doesn't get set.
const CLI_BIN = join(ROOT, 'dist', 'surfaces', 'cli', 'index.js');
if (existsSync(CLI_BIN)) {
  chmodSync(CLI_BIN, 0o755);
  console.log(`Marked ${relative(ROOT, CLI_BIN)} executable`);
}
