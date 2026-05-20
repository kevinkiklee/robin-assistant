#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildCoreDeps, buildCoreServer } from './server.ts';

async function main() {
  const deps = buildCoreDeps();
  const server = buildCoreServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: error logging on fatal startup failure
  console.error('robin-core mcp server failed:', err);
  process.exit(1);
});
