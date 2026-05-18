import { surql } from 'surrealdb';
import { DAY_MS } from '../../config/time.js';

const LOOKBACK_DAYS = 7;
const MIN_QUOTE_WORDS = 10;
const SCAN_LIMIT = 500;

let cache = { maxEventId: null, shinglesById: new Map() };

function tokenize(t) {
  return t.toLowerCase().split(/\s+/).filter(Boolean);
}

function shinglesOf(content) {
  const toks = tokenize(content);
  if (toks.length < MIN_QUOTE_WORDS) return new Set();
  const s = new Set();
  for (let i = 0; i + MIN_QUOTE_WORDS <= toks.length; i++) {
    s.add(toks.slice(i, i + MIN_QUOTE_WORDS).join(' '));
  }
  return s;
}

async function refreshCache(db) {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS);
  const [latest] = await db
    .query(
      surql`SELECT VALUE id FROM events WHERE trust IN ['untrusted','untrusted-mixed'] ORDER BY id DESC LIMIT 1`,
    )
    .collect();
  const latestId = latest?.[0] ? String(latest[0]) : null;
  if (latestId === cache.maxEventId) return;
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts FROM events WHERE trust IN ['untrusted','untrusted-mixed'] AND ts >= ${cutoff} ORDER BY ts DESC LIMIT ${SCAN_LIMIT}`,
    )
    .collect();
  const next = new Map();
  for (const r of rows) next.set(String(r.id), shinglesOf(r.content ?? ''));
  cache = { maxEventId: latestId, shinglesById: next };
}

export async function scanForVerbatimQuote(db, text) {
  await refreshCache(db);
  const replyShingles = shinglesOf(text);
  if (replyShingles.size === 0) return { found: false };
  for (const [eventId, sourceShingles] of cache.shinglesById) {
    for (const s of sourceShingles) {
      if (replyShingles.has(s)) return { found: true, eventId, shingle: s };
    }
  }
  return { found: false };
}

export function __resetCacheForTests() {
  cache = { maxEventId: null, shinglesById: new Map() };
}
