#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildExtensionDeps, buildExtensionServer } from './server.ts';

export async function runMcpExtension(): Promise<void> {
  const deps = buildExtensionDeps();
  const server = buildExtensionServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
