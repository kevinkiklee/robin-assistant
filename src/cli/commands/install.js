import { mcpInstall } from './mcp-install.js';
import { migrate } from './migrate.js';

export async function install(argv) {
  console.log('Running migrations...');
  await migrate();
  console.log('');
  console.log('Installing MCP daemon + host registration...');
  await mcpInstall(argv);
  console.log('');
  console.log(
    'Robin is ready. Restart your Claude Code / Gemini CLI session to pick up the new MCP server.',
  );
}
