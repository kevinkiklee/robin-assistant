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

import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surql } from 'surrealdb';
import { listActionTrust, setActionTrust } from '../../cognition/jobs/action-trust.js';
import { approveCandidate, rejectCandidate } from '../../cognition/memory/rules.js';
import { paths } from '../../config/data-store.js';

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
      if (size > max) {
        const e = new Error('payload too large');
        e.statusCode = 413;
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const err = new Error('invalid JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Layer assignment for the inventory view. Compresses the schema into
// L1 (capture) → L2 (compression) → L3 (graph) → L4 (policy) plus
// TEL (telemetry), EMB (embeddings shards), OP (operational). Everything
// else lands in OTHER so the UI never silently drops a table from view.
const LAYER_RULES = [
  { id: 'L1', label: 'L1 · Capture', match: (t) => t === 'events' },
  {
    id: 'L2',
    label: 'L2 · Compression',
    match: (t) => t === 'episodes' || t === 'arcs' || t === 'memos',
  },
  {
    id: 'L3',
    label: 'L3 · Graph',
    match: (t) => t === 'entities' || t === 'edges',
  },
  {
    id: 'L4',
    label: 'L4 · Policy',
    match: (t) =>
      t === 'rules' || t === 'rule_candidates' || t === 'action_trust' || t === 'predictions',
  },
  {
    id: 'TEL',
    label: 'Telemetry',
    match: (t) => /telemetry|_telemetry$/i.test(t),
  },
  { id: 'EMB', label: 'Embeddings', match: (t) => /^embeddings_/.test(t) },
  {
    id: 'OP',
    label: 'Operational',
    match: (t) =>
      t === '_migrations' ||
      t === 'archive_log' ||
      t === 'runtime' ||
      t === 'runtime_jobs' ||
      t === 'runtime_state' ||
      t === 'refusals' ||
      t === 'pending_recall_log' ||
      t === 'trigger_fires' ||
      t === 'invariants_telemetry',
  },
];

export function tableLayer(name) {
  for (const r of LAYER_RULES) if (r.match(name)) return r.id;
  return 'OTHER';
}

function groupByLayer(tables) {
  const groups = new Map(LAYER_RULES.map((r) => [r.id, { id: r.id, label: r.label, tables: [] }]));
  groups.set('OTHER', { id: 'OTHER', label: 'Other', tables: [] });
  for (const t of tables) groups.get(tableLayer(t)).tables.push(t);
  return [...groups.values()].filter((g) => g.tables.length > 0);
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
        if (r.success && Array.isArray(r.result) && r.result[0]?.n != null)
          counts[safe[i]] = r.result[0].n;
      });
    } catch {
      /* best-effort */
    }
  }
  return { tables, counts, layers: groupByLayer(tables) };
}

function parsePagination(u) {
  const rawLimit = Number.parseInt(u.searchParams.get('limit') ?? '', 10);
  const rawOffset = Number.parseInt(u.searchParams.get('offset') ?? '', 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 25;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

async function getTableInfo(db, name, { limit = 25, offset = 0 } = {}) {
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
  } catch (e) {
    schema = { error: String(e?.message ?? e) };
  }
  try {
    const [r] = await db.query(`SELECT count() AS n FROM \`${name}\` GROUP ALL`).collect();
    count = r?.[0]?.n ?? null;
  } catch {
    /* best-effort */
  }
  try {
    const [rows] = await db
      .query(`SELECT * FROM \`${name}\` LIMIT ${limit} START ${offset}`)
      .collect();
    recent = rows ?? [];
  } catch {
    /* best-effort */
  }
  return { name, count, schema, recent, limit, offset };
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
  if (source) where.push(`source = '${String(source).replace(/'/g, '')}'`);
  if (sinceIso) where.push(`ts > d'${sinceIso}'`);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT id, source, ts, content FROM events ${whereClause} ORDER BY ts DESC LIMIT ${Math.min(Number(limit) || 50, 500)}`;
  const [rows] = await db.query(sql).collect();
  return { rows: rows ?? [] };
}

async function getTriggers(db) {
  const [fires] = await db
    .query('SELECT * FROM trigger_fires ORDER BY fired_at DESC LIMIT 50')
    .collect();
  return { recent_fires: fires ?? [] };
}

async function getRules(db, status) {
  const safeStatus = ['pending', 'active', 'rejected'].includes(status) ? status : 'pending';
  try {
    const [rows] = await db
      .query(surql`SELECT * FROM rule_candidates WHERE status = ${safeStatus} LIMIT 50`)
      .collect();
    return { rows: rows ?? [] };
  } catch (e) {
    return { rows: [], error: String(e?.message ?? e) };
  }
}

async function viewDashboard(db) {
  const info = await getInfo(db);
  let recent = [];
  try {
    const [rows] = await db
      .query('SELECT id, source, ts, content, meta FROM events ORDER BY ts DESC LIMIT 25')
      .collect();
    recent = rows ?? [];
  } catch {
    /* best-effort */
  }
  let pendingRules = 0;
  try {
    const [rows] = await db
      .query("SELECT count() AS n FROM rule_candidates WHERE status = 'pending' GROUP ALL")
      .collect();
    pendingRules = Number(rows?.[0]?.n ?? 0);
  } catch {
    /* best-effort */
  }
  return {
    counts: info.counts,
    layers: info.layers,
    recent,
    needs_input: { pending_rules: pendingRules },
    fetched_at: new Date().toISOString(),
  };
}

// Entity-id validator: requires `table:id-chars` where the table name uses
// the standard identifier shape. Anything else is rejected with a friendly
// `error` field rather than 500'ing on a malformed SurrealQL fragment.
const ENTITY_ID_RE = /^[a-z_][a-z0-9_]*:[A-Za-z0-9_]+$/;

async function viewSearch(db, q) {
  const safe = String(q ?? '')
    .slice(0, 80)
    .replace(/'/g, '');
  if (!safe) return { rows: [] };
  try {
    const [rows] = await db
      .query(
        `SELECT id, name, type FROM entities WHERE string::lowercase(name) CONTAINS '${safe.toLowerCase()}' LIMIT 50`,
      )
      .collect();
    return { rows: rows ?? [] };
  } catch (e) {
    return { rows: [], error: String(e?.message ?? e) };
  }
}

async function viewEntity(db, id) {
  if (!ENTITY_ID_RE.test(String(id ?? ''))) return { error: 'bad entity id' };
  try {
    const responses = await db
      .query(
        `SELECT * FROM ${id};
         SELECT * FROM events WHERE ->edges->entities CONTAINS ${id} ORDER BY ts DESC LIMIT 50;
         SELECT * FROM edges WHERE in = ${id} OR out = ${id} LIMIT 100;
         SELECT * FROM episodes WHERE entity_ids CONTAINS ${id} ORDER BY last_activity_at DESC LIMIT 25;`,
      )
      .responses();
    const entity = responses?.[0]?.success ? (responses[0].result?.[0] ?? null) : null;
    const captures = responses?.[1]?.success ? (responses[1].result ?? []) : [];
    const edges = responses?.[2]?.success ? (responses[2].result ?? []) : [];
    const episodes = responses?.[3]?.success ? (responses[3].result ?? []) : [];
    return { entity, captures, edges, episodes };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

async function getJobs(db) {
  try {
    const [rows] = await db.query('SELECT * FROM runtime_jobs LIMIT 100').collect();
    return { rows: rows ?? [] };
  } catch {
    return { rows: [] };
  }
}

async function getIntegrations(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:integrations').collect();
    const m = rows?.[0];
    return { integrations: m && typeof m === 'object' ? m : {} };
  } catch {
    return { integrations: {} };
  }
}

async function getActions(db) {
  try {
    const rows = await listActionTrust(db);
    return { rows };
  } catch (e) {
    return { rows: [], error: String(e?.message ?? e) };
  }
}

const ACTION_STATES = new Set(['AUTO', 'ASK', 'NEVER']);

async function postAction(db, cls, body) {
  const state = String(body?.state ?? '');
  if (!ACTION_STATES.has(state)) {
    const err = new Error(`bad state '${state}' (allowed: AUTO/ASK/NEVER)`);
    err.statusCode = 400;
    throw err;
  }
  const reason = typeof body?.reason === 'string' ? body.reason : null;
  // `set_by` is constrained to the policy-vocab enum; web-UI clicks are
  // user actions, not automated correction/decay sweeps.
  await setActionTrust(db, cls, state, 'user', reason);
  return { class: cls, state };
}

const RULE_ACTIONS = new Set(['approve', 'reject']);

async function postRule(db, id, body) {
  const action = String(body?.action ?? '');
  if (!RULE_ACTIONS.has(action)) {
    const err = new Error(`bad action '${action}' (allowed: approve/reject)`);
    err.statusCode = 400;
    throw err;
  }
  if (!/^rule_candidates:[A-Za-z0-9_-]+$/.test(id)) {
    const err = new Error('bad rule id');
    err.statusCode = 400;
    throw err;
  }
  if (action === 'approve') {
    const out = await approveCandidate(db, id);
    return { status: 'approved', ...(out ?? {}) };
  }
  const out = await rejectCandidate(db, id, body?.reason ?? null);
  return { status: 'rejected', ...(out ?? {}) };
}

async function getDoctor(db) {
  let daemon = null;
  let invariants = null;
  let integrations = {};
  let inFlight = [];
  try {
    const stateFile = paths.runtime?.daemonState?.() ?? null;
    if (stateFile && existsSync(stateFile)) {
      daemon = JSON.parse(readFileSync(stateFile, 'utf8'));
    } else {
      daemon = { error: 'state file missing' };
    }
  } catch (e) {
    daemon = { error: String(e?.message ?? e) };
  }
  try {
    const invFile = paths.runtime?.invariantsState?.() ?? null;
    if (invFile && existsSync(invFile)) {
      invariants = JSON.parse(readFileSync(invFile, 'utf8'));
    } else {
      invariants = { error: 'invariants state missing' };
    }
  } catch (e) {
    invariants = { error: String(e?.message ?? e) };
  }
  try {
    integrations = (await getIntegrations(db)).integrations;
  } catch {
    /* tolerated */
  }
  try {
    const [rows] = await db
      .query('SELECT id, name, started_at FROM runtime_jobs WHERE in_flight = true LIMIT 50')
      .collect();
    inFlight = rows ?? [];
  } catch {
    /* tolerated */
  }
  return {
    daemon,
    invariants,
    integrations,
    in_flight_jobs: inFlight,
    fetched_at: new Date().toISOString(),
  };
}

async function getLogs(lines) {
  const N = Math.max(1, Math.min(Number.parseInt(lines, 10) || 200, 2000));
  try {
    const logFile = paths.runtime?.daemonLog?.() ?? null;
    if (!logFile || !existsSync(logFile)) return { lines: [] };
    const text = await fsp.readFile(logFile, 'utf8');
    const allLines = text.split(/\r?\n/);
    while (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();
    return { lines: allLines.slice(-N) };
  } catch (e) {
    return { lines: [], error: String(e?.message ?? e) };
  }
}

export function makeWebServer({
  db,
  allowWrites = true,
  requireCsrf = false,
  expectedPort = null,
  daemonProxy = null,
} = {}) {
  const indexHtml = existsSync(INDEX_PATH)
    ? readFileSync(INDEX_PATH, 'utf8')
    : '<h1>index.html missing</h1>';
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
        return send(
          res,
          200,
          await getEvents(db, {
            source: u.searchParams.get('source'),
            sinceIso: u.searchParams.get('since'),
            limit: u.searchParams.get('limit'),
          }),
        );
      }
      const tm = method === 'GET' && /^\/api\/table\/([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(path);
      if (tm) {
        const u = new URL(req.url, 'http://x');
        return send(res, 200, await getTableInfo(db, tm[1], parsePagination(u)));
      }

      // View aggregates — composite snapshots that back UI pages.
      if (method === 'GET' && path === '/api/view/dashboard') {
        return send(res, 200, await viewDashboard(db));
      }
      if (method === 'GET' && path === '/api/view/search') {
        const u = new URL(req.url, 'http://x');
        return send(res, 200, await viewSearch(db, u.searchParams.get('q')));
      }
      if (method === 'GET' && path === '/api/view/entity') {
        const u = new URL(req.url, 'http://x');
        return send(res, 200, await viewEntity(db, u.searchParams.get('id')));
      }
      if (method === 'GET' && path === '/api/jobs') return send(res, 200, await getJobs(db));
      if (method === 'GET' && path === '/api/integrations') {
        return send(res, 200, await getIntegrations(db));
      }
      if (method === 'GET' && path === '/api/actions') return send(res, 200, await getActions(db));
      if (method === 'GET' && path === '/api/doctor') return send(res, 200, await getDoctor(db));
      if (method === 'GET' && path === '/api/logs') {
        const u = new URL(req.url, 'http://x');
        return send(res, 200, await getLogs(u.searchParams.get('lines')));
      }

      // Write surfaces — gated by allowWrites + (when configured) CSRF.
      const am = /^\/api\/actions\/([A-Za-z0-9_:%-]+)$/.exec(path);
      if (am && method === 'POST') {
        if (!allowWrites) return send(res, 403, { error: 'writes disabled' });
        const body = await readJson(req);
        const cls = decodeURIComponent(am[1]);
        return send(res, 200, await postAction(db, cls, body));
      }
      const rm = /^\/api\/rule\/([A-Za-z0-9_:%-]+)$/.exec(path);
      if (rm && method === 'POST') {
        if (!allowWrites) return send(res, 403, { error: 'writes disabled' });
        const body = await readJson(req);
        const id = decodeURIComponent(rm[1]);
        return send(res, 200, await postRule(db, id, body));
      }
      if (path === '/api/admin/run-job' && method === 'POST') {
        if (!allowWrites) return send(res, 403, { error: 'writes disabled' });
        if (!daemonProxy) return send(res, 503, { error: 'daemon proxy not configured' });
        const body = await readJson(req);
        const out = await daemonProxy.runJob(body);
        return send(res, 200, out);
      }

      if (path === '/api/query') {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return send(res, 405, { error: 'method not allowed' });
        }
        if (!allowWrites) return send(res, 403, { error: 'writes disabled' });
        const body = await readJson(req);
        if (!body.sql || typeof body.sql !== 'string')
          return send(res, 400, { error: 'missing sql' });
        return send(res, 200, await runQuery(db, body.sql));
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, Number.isInteger(e?.statusCode) ? e.statusCode : 500, {
        error: String(e?.message ?? e),
      });
    }
  });
}

export async function startWebServer({
  db,
  socketPath,
  port,
  host = '127.0.0.1',
  allowWrites = true,
  requireCsrf,
} = {}) {
  // CSRF defaults: enforce on TCP (browser tabs are an attack vector),
  // off on UNIX socket (process-level boundary).
  const csrf = requireCsrf ?? !socketPath;
  const server = makeWebServer({
    db,
    allowWrites,
    requireCsrf: csrf,
    expectedPort: socketPath ? null : port,
  });
  return new Promise((resolve, reject) => {
    if (socketPath) {
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          /* ignore */
        }
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
export const __test__ = { isHostAllowed, newCsrfToken, csrfTokens, tableLayer };
