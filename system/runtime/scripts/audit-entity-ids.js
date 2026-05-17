#!/usr/bin/env node

// Audit: surface entities whose record id key fails SAFE_ID_KEY checks, OR
// whose current id key drifts from `entityRecordKey(type, name)`'s output.
//
// Why this exists: SurrealDB renders id keys with chars outside [A-Za-z0-9_]
// as `tb:⟨…⟩` and `validateEdge` rejects that form. Legacy entity rows from
// before `entityRecordKey()` sanitized the id silently fail every
// `relateAll([{from: ev, to: legacyEntity, kind}])` slice via per-edge
// rejection, dropping the edge without surfacing the loss. The 2026-05-14
// `daemon.log` audit found 1,751 such silently-dropped edges.
//
// Read-only. Counts and samples. Run as a regression tripwire after
// schema migrations or post-import.

import { ensureHome } from '../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../data/db/client.js';

const SAFE = /^[A-Za-z0-9_]+$/;

function recordKey(rid) {
  if (rid == null) return null;
  let s = typeof rid === 'string' ? rid : null;
  if (s == null && typeof rid === 'object' && rid.id != null) {
    s = typeof rid.id === 'string' ? rid.id : String(rid.id);
  }
  if (s == null) return null;
  // Strip mathematical-bracket wrapping (⟨…⟩) or backtick wrapping that
  // SurrealDB emits for keys with chars outside [A-Za-z0-9_].
  if (s.length >= 2) {
    const first = s.charCodeAt(0);
    const last = s.charCodeAt(s.length - 1);
    if (first === 0x27e8 && last === 0x27e9) return s.slice(1, -1);
    if (s[0] === '`' && s[s.length - 1] === '`') return s.slice(1, -1);
  }
  return s;
}

function safeName(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unnamed'
  );
}

await ensureHome();
const db = await connect({ engine: await defaultDbUrl() });
try {
  const all = await db.query('SELECT id, name, type FROM entities').collect();
  const rows = all[0] ?? [];
  console.log(`total entities: ${rows.length}`);

  const unsafe = [];
  for (const r of rows) {
    let idPortion = null;
    if (typeof r.id === 'object' && r.id !== null) {
      idPortion = r.id.id ?? null;
    } else if (typeof r.id === 'string') {
      const i = r.id.indexOf(':');
      idPortion = i === -1 ? r.id : r.id.slice(i + 1);
    }
    const k = recordKey(idPortion);
    if (!k || SAFE.test(k)) continue;
    unsafe.push({ id: String(r.id), key: k, name: r.name, type: r.type });
  }
  console.log(`unsafe id rows: ${unsafe.length}`);
  for (const u of unsafe.slice(0, 20)) {
    console.log(`  ${u.id}  key="${u.key}"  name="${u.name}"  type=${u.type}`);
  }

  let drift = 0;
  const driftSamples = [];
  for (const r of rows) {
    if (!r.name || !r.type) continue;
    const idPortion =
      typeof r.id === 'object' && r.id !== null ? r.id.id : String(r.id).split(':')[1];
    if (!idPortion) continue;
    const expected = `${r.type}__${safeName(r.name)}`;
    if (String(idPortion) !== expected) {
      drift++;
      if (driftSamples.length < 10) {
        driftSamples.push({ id: String(r.id), name: r.name, expected });
      }
    }
  }
  console.log(`name-vs-id drift rows: ${drift}`);
  for (const d of driftSamples) {
    console.log(`  current=${d.id}  expected=entities:${d.expected}  name="${d.name}"`);
  }

  // Non-zero exit when either count is non-zero so CI / robin doctor can
  // surface this as a real failure rather than a silent passthrough.
  if (unsafe.length > 0 || drift > 0) process.exit(1);
} finally {
  await close(db);
}
