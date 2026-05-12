import { createServer } from 'node:http';
import { handleSse } from './mcp-sse.js';
import { validate } from './schema.js';

// 5 MB is well above any legitimate /internal/* payload (the largest are
// recall/remember bodies with full event content). Higher than this is an
// accident or a runaway local client; loopback-only binding mitigates
// external risk, but a memory-bomb from a local process still costs us.
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function readJsonBody(req) {
  return await new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let received = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return; // stop accumulating once over the cap
      received += c.length;
      if (received > MAX_BODY_BYTES) {
        rejected = true;
        const err = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        err.name = 'RobinPayloadTooLargeError';
        rejectBody(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return; // promise already rejected
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
// Constant-time compare: short-circuiting `===` on a hex string would leak
// the prefix length the comparison matched against. Hex is fixed-width so
// length-mismatch can be rejected up front without leaking the secret.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function startHttp({ ctx, tools, routes, port, authToken }) {
  const table = new Map();
  for (const r of routes) table.set(`${r.method} ${r.path}`, r);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/sse')) {
        await handleSse(req, res, { ctx, tools });
        return;
      }
      // Bearer-token gate for /internal/*. Other paths (health probes, /sse)
      // remain unauthenticated — the MCP transport has its own auth surface
      // and probes need to work for supervisors that don't carry the token.
      if (authToken && req.url.startsWith('/internal/')) {
        const presented = extractBearer(req);
        if (!presented || !safeEqual(presented, authToken)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                'missing or invalid Authorization. CLI commands read the token from <robinHome>/.daemon.state; restart the daemon (`robin mcp restart`) if the token in your shell session is stale.',
              name: 'RobinUnauthorizedError',
            }),
          );
          return;
        }
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
        if (e.name === 'RobinPayloadTooLargeError') {
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ ok: false, error: e.message, name: e.name }));
          // Drop any remaining inbound bytes so the client gets ECONNRESET
          // instead of us buffering the rest of the (oversized) upload.
          req.destroy();
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
