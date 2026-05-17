// Local web admin UI — substrate (M4 first cut).
//
// Routes:
//   GET  /                       index.html (single-page app)
//   GET  /static/app.css         theme tokens + layout
//   GET  /api/info               table list, counts, layers
//   GET  /api/table/:name        per-table schema + recent rows
//   GET  /api/events             tail of events (filter by ?source, ?since)
//   GET  /api/triggers           registered triggers + recent fires
//   GET  /api/rules?status=      list rule candidates
//   POST /api/query              run SurrealQL (CSRF-protected)
//   POST /api/csrf-token         issue a fresh CSRF token
//
// Security:
//   - UNIX socket bind (default) — no TCP browser-tab attack surface.
//   - Optional TCP bind for tailnet use; in TCP mode all POSTs require
//     a fresh CSRF token from /api/csrf-token + sent in X-CSRF-Token.
//   - DNS-rebinding defense (Host header check) when TCP.
//   - Body size cap 1 MB.
//   - Security headers on every response.
//
// Bigger feature set (view pages, card renderers, write tools) ports
// incrementally from the v1 design captured in
// user-data/artifacts/db-browser-v1-design-2026-05-17.md.

import { createServer } from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { surql } from 'surrealdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, 'index.html');
const CSS_PATH = join(__dirname, 'app.css');

const DEFAULT_BODY_MAX = 1_000_000;
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const csrfTokens = new Set();
const CSRF_TOKEN_TTL_MS = 10 * 60_000;

function newCsrfToken() {
  const token = randomBytes(24).toString('hex');
  csrfTokens.add(token);
  setTimeout(() => csrfTokens.delete(token), CSRF_TOKEN_TTL_MS).unref?.();
  return token;
}

function send(res, status, body, type = 'application/json') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const length = Buffer.byteLength(payload);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': length,
  });
  if (res.req?.method === 'HEAD') res.end();
  else res.end(payload);
}

function isHostAllowed(hostHeader, expectedPort) {
  if (!hostHeader) return false;
  const m = String(hostHeader).match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  const port = m[2] ? Number(m[2]) : null;
  if (!ALLOWED_HOSTNAMES.has(host)) return false;
  if (expectedPort != null && port != null && port !== expectedPort) return false;
  return true;
}

async function readJson(req, max = DEFAULT_BODY_MAX) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { const e = new Error('payload too large'); e.statusCode = 413; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { const err = new Error('invalid JSON'); err.statusCode = 400; reject(err); }
    });
    req.on('error', reject);
  });
}

async function getInfo(db) {
  const [info] = await db.query('INFO FOR DB').collect();
  const tables = Object.keys(info?.tables ?? {}).sort();
  const counts = {};
  const safe = tables.filter((t) => /^[a-z_][a-z0-9_]*$/i.test(t));
  if (safe.length) {
    const sql = safe.map((t) => `SELECT count() AS n FROM \`${t}\` GROUP ALL`).join(';\n');
    try {
      const responses = await db.query(sql).responses();
      responses.forEach((r, i) => {
        if (r.success && Array.isArray(r.result) && r.result[0]?.n != null) counts[safe[i]] = r.result[0].n;
      });
    } catch { /* best-effort */ }
  }
  return { tables, counts };
}

async function getTableInfo(db, name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return { error: 'bad table name' };
  let schema = null;
  let count = null;
  let recent = [];
  try {
    const [info] = await db.query(`INFO FOR TABLE \`${name}\``).collect();
    const fields = Object.entries(info?.fields ?? {})
      .filter(([k]) => !k.includes('.'))
      .map(([k, v]) => ({ name: k, def: stripDef(v) }));
    schema = { fields };
  } catch (e) { schema = { error: String(e?.message ?? e) }; }
  try {
    const [r] = await db.query(`SELECT count() AS n FROM \`${name}\` GROUP ALL`).collect();
    count = r?.[0]?.n ?? null;
  } catch { /* best-effort */ }
  try {
    const [rows] = await db.query(`SELECT * FROM \`${name}\` LIMIT 25`).collect();
    recent = rows ?? [];
  } catch { /* best-effort */ }
  return { name, count, schema, recent };
}

function stripDef(def) {
  if (typeof def !== 'string') return '';
  return def.replace(/^DEFINE FIELD \S+ ON \S+ /, '').replace(/\s+PERMISSIONS\s+\w+$/i, '');
}

async function runQuery(db, sql) {
  const t0 = performance.now();
  const responses = await db.query(sql).responses();
  return {
    ms: +(performance.now() - t0).toFixed(1),
    responses: responses.map((r) => ({
      success: r.success,
      result: r.success ? r.result : undefined,
      error: r.success ? undefined : String(r.error?.message ?? r.error ?? 'unknown'),
    })),
  };
}

async function getEvents(db, { source, sinceIso, limit }) {
  const where = [];
  if (source) where.push(`source = '${String(source).replace(/'/g, "")}'`);
  if (sinceIso) where.push(`ts > d'${sinceIso}'`);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT id, source, ts, content FROM events ${whereClause} ORDER BY ts DESC LIMIT ${Math.min(Number(limit) || 50, 500)}`;
  const [rows] = await db.query(sql).collect();
  return { rows: rows ?? [] };
}

async function getTriggers(db) {
  const [fires] = await db.query('SELECT * FROM trigger_fires ORDER BY fired_at DESC LIMIT 50').collect();
  return { recent_fires: fires ?? [] };
}

async function getRules(db, status) {
  const safeStatus = ['pending', 'active', 'rejected'].includes(status) ? status : 'pending';
  try {
    const [rows] = await db.query(surql`SELECT * FROM rule_candidates WHERE status = ${safeStatus} LIMIT 50`).collect();
    return { rows: rows ?? [] };
  } catch (e) {
    return { rows: [], error: String(e?.message ?? e) };
  }
}

export function makeWebServer({ db, allowWrites = true, requireCsrf = false, expectedPort = null } = {}) {
  const indexHtml = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf8') : '<h1>index.html missing</h1>';
  const cssText = existsSync(CSS_PATH) ? readFileSync(CSS_PATH, 'utf8') : '/* app.css missing */';

  return createServer(async (req, res) => {
    try {
      // DNS-rebinding when bound to TCP. UNIX socket has no Host header issue
      // (other apps can't reach a socket file without filesystem access).
      if (expectedPort && !isHostAllowed(req.headers.host, expectedPort)) {
        return send(res, 403, { error: 'host not allowed' });
      }
      const path = (req.url ?? '/').split('?', 1)[0].replace(/\/+$/, '') || '/';
      const method = req.method;

      // CSRF check on state-changing requests. The token-issuance endpoint
      // is exempt — that's the chicken-and-egg.
      const path0 = (req.url ?? '/').split('?', 1)[0].replace(/\/+$/, '') || '/';
      if (requireCsrf && method !== 'GET' && method !== 'HEAD' && path0 !== '/api/csrf-token') {
        const token = req.headers['x-csrf-token'];
        if (!token || !csrfTokens.has(String(token))) {
          return send(res, 403, { error: 'csrf token missing or invalid' });
        }
      }

      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        return send(res, 200, indexHtml, 'text/html; charset=utf-8');
      }
      if (method === 'GET' && path === '/static/app.css') {
        return send(res, 200, cssText, 'text/css; charset=utf-8');
      }
      if (method === 'POST' && path === '/api/csrf-token') {
        return send(res, 200, { token: newCsrfToken() });
      }
      if (method === 'GET' && path === '/api/info') {
        return send(res, 200, await getInfo(db));
      }
      if (method === 'GET' && path === '/api/triggers') {
        return send(res, 200, await getTriggers(db));
      }
      if (method === 'GET' && path === '/api/rules') {
        const u = new URL(req.url, 'http://x');
        return send(res, 200, await getRules(db, u.searchParams.get('status') ?? 'pending'));
      }
      if (method === 'GET' && path === '/api/events') {
        const u = new URL(req.url, 'http://x');
        return send(res, 200, await getEvents(db, {
          source: u.searchParams.get('source'),
          sinceIso: u.searchParams.get('since'),
          limit: u.searchParams.get('limit'),
        }));
      }
      const tm = method === 'GET' && /^\/api\/table\/([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(path);
      if (tm) return send(res, 200, await getTableInfo(db, tm[1]));

      if (path === '/api/query') {
        if (method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'method not allowed' }); }
        if (!allowWrites) return send(res, 403, { error: 'writes disabled' });
        const body = await readJson(req);
        if (!body.sql || typeof body.sql !== 'string') return send(res, 400, { error: 'missing sql' });
        return send(res, 200, await runQuery(db, body.sql));
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, Number.isInteger(e?.statusCode) ? e.statusCode : 500, { error: String(e?.message ?? e) });
    }
  });
}

export async function startWebServer({ db, socketPath, port, host = '127.0.0.1', allowWrites = true, requireCsrf } = {}) {
  // CSRF defaults: enforce on TCP (browser tabs are an attack vector),
  // off on UNIX socket (process-level boundary).
  const csrf = requireCsrf ?? !socketPath;
  const server = makeWebServer({ db, allowWrites, requireCsrf: csrf, expectedPort: socketPath ? null : port });
  return new Promise((resolve, reject) => {
    if (socketPath) {
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }
      server.listen(socketPath, () => resolve({ server, socketPath, csrf }));
    } else {
      server.listen(port ?? 18791, host, () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === 'object' ? addr.port : port, host, csrf });
      });
    }
    server.on('error', reject);
  });
}

// Exported for tests.
export const __test__ = { isHostAllowed, newCsrfToken, csrfTokens };
