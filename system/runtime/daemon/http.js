import { createServer } from 'node:http';
import { handleSse } from './mcp-sse.js';
import { validate } from './schema.js';

async function readJsonBody(req) {
  return await new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        const err = new Error('invalid JSON body');
        err.name = 'RobinInvalidJsonError';
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

/**
 * Build an HTTP server backed by a route table.
 *
 * Route shape: `{ method, path, schema?, handler({ ctx, body, tools }) }`.
 *
 * Handler return value:
 *  - `result` → 200 application/json, envelope: { ok: true, ...result }
 *  - `{ _status, _body, _headers? }` → escape hatch; envelope NOT applied
 *
 * If `schema` is declared, the body is validated before the handler runs.
 * Validation failure → 400 { ok: false, error, name: 'RobinValidationError', validation }.
 * Invalid JSON → 400 { ok: false, error, name: 'RobinInvalidJsonError' }.
 *
 * GET /sse is special-cased (long-lived SSE, not in the table). Unmatched
 * routes return 404. Uncaught handler errors return 500 with the envelope.
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

      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        if (e.name === 'RobinInvalidJsonError') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message, name: e.name }));
          return;
        }
        throw e;
      }

      if (entry.schema) {
        const v = validate(body, entry.schema);
        if (!v.ok) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error: 'invalid request body',
              name: 'RobinValidationError',
              validation: v.errors,
            }),
          );
          return;
        }
        body = v.value;
      }

      const result = await entry.handler({ ctx, body, tools });

      if (result && typeof result === 'object' && '_status' in result) {
        // Escape hatch: handler owns the full response; no envelope wrap.
        res.writeHead(result._status, result._headers ?? { 'content-type': 'application/json' });
        res.end(
          typeof result._body === 'string' ? result._body : JSON.stringify(result._body ?? {}),
        );
        return;
      }
      // Envelope: ok: true always wins on the success path.
      const envelope = Object.assign({}, result, { ok: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(envelope));
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message, name: e.name }));
      } catch {
        /* response already sent */
      }
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
