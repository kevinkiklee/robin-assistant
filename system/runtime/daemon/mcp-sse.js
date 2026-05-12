import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Handle a GET /sse upgrade. Special-cased because the SSE flow is a
 * long-lived connection that owns its own request/response lifecycle and
 * doesn't fit the {ctx, body} → result route shape.
 */
export async function handleSse(req, res, { ctx, tools }) {
  ctx.sessions.count++;
  // Wire close BEFORE the async setup. If the client disconnects between
  // `count++` and `mcpServer.connect()` returning (a real race during
  // shutdown or flaky clients), the post-await listener would never attach
  // and the counter would leak upward.
  req.once('close', () => {
    ctx.sessions.count = Math.max(0, ctx.sessions.count - 1);
  });
  const transport = new SSEServerTransport('/messages', res);
  const mcpServer = new Server(
    { name: 'robin', version: ctx.version },
    { capabilities: { tools: {} } },
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
    }
    try {
      const result = await tool.handler(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      // Sanitise tool errors before returning them to the MCP client: raw
      // e.message can carry absolute paths, surreal connection strings,
      // API response bodies, or session/auth tokens. We log the full error
      // server-side (callers can chase it via cache/logs/daemon.log) and
      // hand back a non-revealing summary tagged by name + tool.
      console.error(`tool ${name} failed: ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
      const summary = `tool '${name}' failed (${e?.name ?? 'Error'}). See daemon.log for details.`;
      return { isError: true, content: [{ type: 'text', text: summary }] };
    }
  });
  await mcpServer.connect(transport);
}
