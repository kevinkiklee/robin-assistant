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
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
  await mcpServer.connect(transport);
  req.on('close', () => {
    ctx.sessions.count = Math.max(0, ctx.sessions.count - 1);
  });
}
