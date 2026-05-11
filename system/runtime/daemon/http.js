import { createServer } from 'node:http';
import { handleSse } from './mcp-sse.js';

async function readJsonBody(req) {
  return await new Promise((resolveBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        resolveBody({});
      }
    });
    req.on('error', () => resolveBody({}));
  });
}

/**
 * Build an HTTP server backed by a route table.
 *
 * Route shape: `{ method, path, handler({ ctx, body, tools }) }`.
 *
 * Handler return value:
 *  - `result` → 200 application/json, JSON.stringify(result)
 *  - `{ _status, _body, _headers? }` → escape hatch for non-200 responses
 *
 * GET /sse is special-cased (long-lived SSE connection, not in the table).
 * Unmatched routes return 404. Uncaught handler errors return 500 with
 * `{ error, name }`.
 */
export function startHttp({ ctx, tools, routes, port }) {
  const table = new Map();
  for (const r of routes) table.set(`${r.method} ${r.path}`, r);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/sse')) {
        await handleSse(req, res, { ctx, tools });
        return;
      }
      const entry = table.get(`${req.method} ${req.url}`);
      if (!entry) {
        res.writeHead(404).end();
        return;
      }
      const body = await readJsonBody(req);
      const result = await entry.handler({ ctx, body, tools });
      if (result && typeof result === 'object' && '_status' in result) {
        res.writeHead(result._status, result._headers ?? { 'content-type': 'application/json' });
        res.end(
          typeof result._body === 'string' ? result._body : JSON.stringify(result._body ?? {}),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? {}));
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, name: e.name }));
      } catch {
        /* response already sent */
      }
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
