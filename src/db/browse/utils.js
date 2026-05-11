// Server-side helpers shared across browse handlers.
// Loopback-only; same Host/Origin guards as v1.

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isHostAllowed(hostHeader, expectedPort) {
  if (!hostHeader) return false;
  const m = String(hostHeader).match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const host = m[1].toLowerCase();
  const port = m[2] ? Number(m[2]) : null;
  if (!ALLOWED_HOSTNAMES.has(host)) return false;
  if (expectedPort != null && port != null && port !== expectedPort) return false;
  return true;
}

export function isOriginAllowed(originHeader, expectedPort) {
  if (!originHeader) return true;
  try {
    const u = new URL(originHeader);
    if (!ALLOWED_HOSTNAMES.has(u.hostname.toLowerCase())) return false;
    if (expectedPort != null && u.port && Number(u.port) !== expectedPort) return false;
    return true;
  } catch {
    return false;
  }
}

export async function readJsonBody(req, max) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > max) {
        aborted = true;
        const e = new Error('payload too large');
        e.statusCode = 413;
        return reject(e);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const err = new Error('invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const length = Buffer.byteLength(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': length,
  });
  if (res.req?.method === 'HEAD') res.end();
  else res.end(payload);
}

export function sendText(res, status, body, type) {
  const payload = String(body);
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

// Convert a list of record-id strings ("entity:abc" or just "abc") into a
// SurrealQL inline literal array of typed record references. Sanitised: only
// alnum + underscore + hyphen permitted in the id segment.
export function recordIdList(table, ids) {
  const safeTable = /^[a-z_][a-z0-9_]*$/i.test(table) ? table : null;
  if (!safeTable) return '[]';
  const cleaned = (ids || [])
    .map((s) => {
      if (s == null) return null;
      const str = String(s);
      const idPart = str.includes(':') ? str.split(':').slice(1).join(':') : str;
      return /^[A-Za-z0-9_-]{1,128}$/.test(idPart) ? idPart : null;
    })
    .filter(Boolean);
  if (!cleaned.length) return '[]';
  return `[${cleaned.map((x) => `${safeTable}:${x}`).join(', ')}]`;
}

export function recordIdString(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.includes(':') ? v : null;
  const s = String(v);
  return s.includes(':') ? s : null;
}

export async function getOne(db, sql, vars) {
  try {
    const responses = await db.query(sql, vars).responses();
    const first = responses[0];
    if (!first?.success) return null;
    const r = first.result;
    if (Array.isArray(r)) return r[0] ?? null;
    return r ?? null;
  } catch {
    return null;
  }
}

export async function getAll(db, sql, vars) {
  try {
    const responses = await db.query(sql, vars).responses();
    const first = responses[0];
    if (!first?.success) return [];
    const r = first.result;
    return Array.isArray(r) ? r : r ? [r] : [];
  } catch {
    return [];
  }
}
