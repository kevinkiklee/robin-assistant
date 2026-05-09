import { mcpStart } from './mcp-start.js';
import { mcpStop } from './mcp-stop.js';

export async function mcpRestart() {
  await mcpStop();
  await new Promise((r) => setTimeout(r, 500));
  await mcpStart();
}
