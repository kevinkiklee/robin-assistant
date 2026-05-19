#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildCoreServer, buildCoreDeps } from './server.ts';

async function main() {
  const deps = buildCoreDeps();
  const server = buildCoreServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('robin-core mcp server failed:', err);
  process.exit(1);
});
