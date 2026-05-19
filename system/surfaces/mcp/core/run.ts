#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildCoreServer, buildCoreDeps } from './server.ts';

export async function runMcpCore(): Promise<void> {
  const deps = buildCoreDeps();
  const server = buildCoreServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
