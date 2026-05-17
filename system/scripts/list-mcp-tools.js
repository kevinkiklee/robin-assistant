#!/usr/bin/env node
// Lists MCP tools from the on-disk inventory under system/io/mcp/tools/,
// one per line, sorted. Intended for smoke-test comparison; future work
// will cross-check against the live daemon's registered tools (see below).

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, '..', 'io', 'mcp', 'tools');

async function listFromDisk() {
  const entries = await readdir(toolsDir);
  return entries
    .filter((e) => e.endsWith('.js') && !e.startsWith('_') && e !== 'index.js')
    .map((e) => e.replace(/\.js$/, ''))
    .sort();
}

async function main() {
  const disk = await listFromDisk();
  for (const t of disk) console.log(t);
  // Future: when an "introspect" MCP endpoint exists, cross-check live registration.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
