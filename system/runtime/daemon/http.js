import { createServer } from 'node:http';
import { handlePostMessage, handleSse } from './mcp-sse.js';
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

// DNS-rebinding defense for loopback-bound HTTP servers. A malicious page can
// resolve attacker.com to 127.0.0.1 via short-TTL DNS and have the browser
// send same-origin-looking requests to our local daemon. We block them by
// requiring the Host header to name a loopback target and rejecting any
// Origin that isn't a loopback URL (CLI/MCP clients don't set Origin at all).
function isLoopbackHost(value) {
  if (typeof value !== 'string') return false;
  // Strip optional :port for the comparison.
  const host = value.replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
function isLoopbackOrigin(value) {
  if (typeof value !== 'string' || value === 'null') return false;
  try {
    const u = new URL(value);
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

function rejectNonLoopback(req, res) {
  if (!isLoopbackHost(req.headers.host ?? '')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: 'non-loopback Host header',
        name: 'RobinForbiddenError',
      }),
    );
    return true;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        error: 'non-loopback Origin header',
        name: 'RobinForbiddenError',
      }),
    );
    return true;
  }
  return false;
}

export function startHttp({ ctx, tools, routes, port, authToken }) {
  const table = new Map();
  for (const r of routes) table.set(`${r.method} ${r.path}`, r);

  const server = createServer(async (req, res) => {
    try {
      if (rejectNonLoopback(req, res)) return;
      // Unauthenticated supervisor health probe. mcp.daemon_responds invariant
      // SIGTERMs the daemon when this probe fails — leaving the route missing
      // produces a heartbeat-driven SIGTERM/respawn loop. Keep this minimal:
      // the daemon's mere ability to handle the request is sufficient signal
      // that it's alive; deep status lives behind the MCP `health` tool.
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Bearer-token gate. When `authToken` is configured, /sse, /messages,
      // and /internal/* all require a valid token. /healthz stays open for
      // supervisors that probe without the token. Free-form public routes
      // registered through the routes table remain ungated by default —
      // they're explicitly opt-in by virtue of not living under /internal,
      // /sse, or /messages and predate the SSE-transport hardening.
      const url = req.url ?? '';
      const requiresAuth =
        authToken &&
        (url.startsWith('/sse') || url.startsWith('/messages') || url.startsWith('/internal/'));
      if (requiresAuth) {
        const presented = extractBearer(req);
        if (!presented || !safeEqual(presented, authToken)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                'missing or invalid Authorization. CLI commands read the token from <robinHome>/runtime/daemon/.state; restart the daemon (`robin mcp restart`) if the token in your shell session is stale.',
              name: 'RobinUnauthorizedError',
            }),
          );
          return;
        }
      }
      if (req.method === 'GET' && req.url.startsWith('/sse')) {
        await handleSse(req, res, { ctx, tools });
        return;
      }
      // POST /messages?sessionId=… is the client→server half of the MCP
      // SSE protocol. Matched after the auth gate but before readJsonBody:
      // the SDK's handlePostMessage reads the raw body via raw-body and a
      // body that has already been drained surfaces as 'Invalid message'
      // from the JSON-RPC parser.
      if (req.method === 'POST' && req.url.startsWith('/messages')) {
        await handlePostMessage(req, res);
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
      // Surface uncaught handler errors so operators can diagnose. Without
      // this log line a 500 is invisible: clients see `{ok:false, error:...}`
      // but the daemon process leaves no trace. `[http]` keeps the line
      // greppable in the launchd / systemd journal.
      console.error(
        `[http] ${req.method} ${req.url} → 500: ${e?.name ?? 'Error'}: ${e?.message ?? e}`,
      );
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
