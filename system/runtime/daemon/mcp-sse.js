import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Active SSE transports keyed by sessionId. Populated in handleSse and
// drained on the response's `close` event. The MCP SSE protocol splits a
// session across two connections (long-lived GET /sse + per-message
// POST /messages?sessionId=…), so the daemon has to keep a sessionId →
// transport join map; without it the POST route can't reach the running
// Server instance. Process-local Map is fine: SSE connections are
// inherently per-process, and the daemon never shares state across forks.
const transports = new Map();

/**
 * Handle a GET /sse upgrade. Special-cased because the SSE flow is a
 * long-lived connection that owns its own request/response lifecycle and
 * doesn't fit the {ctx, body} → result route shape.
 */
export async function handleSse(req, res, { ctx, tools }) {
  ctx.sessions.count++;
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  // Wire close BEFORE the async setup. If the client disconnects between
  // `count++` and `mcpServer.connect()` returning (a real race during
  // shutdown or flaky clients), the post-await listener would never attach
  // and the counter would leak upward.
  req.once('close', () => {
    ctx.sessions.count = Math.max(0, ctx.sessions.count - 1);
    transports.delete(transport.sessionId);
  });
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
      // server-side (callers can chase it via runtime/logs/daemon.log) and
      // hand back a non-revealing summary tagged by name + tool.
      console.error(`tool ${name} failed: ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
      const summary = `tool '${name}' failed (${e?.name ?? 'Error'}). See daemon.log for details.`;
      return { isError: true, content: [{ type: 'text', text: summary }] };
    }
  });
  await mcpServer.connect(transport);
}

/**
 * Handle a POST /messages?sessionId=… from an SSE-connected client. Routes
 * the request to the matching transport's handlePostMessage, which reads
 * the raw body itself (don't consume it upstream) and writes back 202
 * Accepted; the actual JSON-RPC response is delivered out-of-band over the
 * client's open /sse stream.
 */
export async function handlePostMessage(req, res) {
  // Loopback bind in startHttp means host is always 127.0.0.1; the base URL
  // is only used to satisfy the WHATWG parser for the relative path+query.
  const url = new URL(req.url, 'http://127.0.0.1');
  const sessionId = url.searchParams.get('sessionId');
  const transport = sessionId ? transports.get(sessionId) : null;
  if (!transport) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: sessionId
          ? `no active SSE session for sessionId=${sessionId}`
          : 'missing sessionId query parameter',
        name: 'RobinUnknownSseSessionError',
      }),
    );
    return;
  }
  await transport.handlePostMessage(req, res);
}
