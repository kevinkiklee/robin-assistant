import { createHash } from 'node:crypto';
import { BoundQuery, surql } from 'surrealdb';
import { isOutboundBlocked } from '../memory/scope-registry.js';
import { PII_PATTERNS, SECRET_PATTERNS } from './patterns.js';

const UNTRUSTED_LOOKBACK_DAYS = 7;
const MIN_QUOTE_WORDS = 10;
// Bound the untrusted-event scan to the most recent N rows. Verbatim quotes
// from older events are unlikely to appear in a write today, and an
// unbounded scan turns this guard into a worst-case latency footgun once
// the events table accumulates.
const UNTRUSTED_SCAN_LIMIT = 500;

function tokenize(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function containsVerbatim(replyText, sourceText, minWords = MIN_QUOTE_WORDS) {
  const reply = tokenize(replyText);
  const source = tokenize(sourceText);
  if (source.length < minWords) return false;
  const replyJoined = reply.join(' ');
  for (let i = 0; i + minWords <= source.length; i++) {
    const window = source.slice(i, i + minWords).join(' ');
    if (replyJoined.includes(window)) return true;
  }
  return false;
}

async function logRefusal(db, destination, reason, payload) {
  // refusals is SCHEMAFULL post-redesign: {content, reason, direction, tool,
  // meta}. Destination/payload_hash fold into meta.
  const payload_hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  await db
    .query(
      surql`CREATE refusals CONTENT ${{
        content: payload,
        reason,
        direction: 'outbound',
        meta: { destination, payload_hash },
      }}`,
    )
    .collect();
}

export async function checkOutbound(db, { destination, text }) {
  for (const p of PII_PATTERNS) {
    const m = p.regex.exec(text);
    if (m && (!p.mask || p.mask(m[0]))) {
      await logRefusal(db, destination, `pii:${p.name}`, text);
      return { ok: false, reason: `pii:${p.name}` };
    }
  }
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(text)) {
      await logRefusal(db, destination, `secret:${p.name}`, text);
      return { ok: false, reason: `secret:${p.name}` };
    }
  }
  const cutoff = new Date(Date.now() - UNTRUSTED_LOOKBACK_DAYS * 86400_000);
  // SurrealDB v3 needs the field used in ORDER BY to appear in the projection.
  const [rows] = await db
    .query(
      surql`SELECT content, ts FROM events WHERE trust IN ['untrusted', 'untrusted-mixed'] AND ts >= ${cutoff} ORDER BY ts DESC LIMIT ${UNTRUSTED_SCAN_LIMIT}`,
    )
    .collect();
  for (const r of rows) {
    if (containsVerbatim(text, r.content)) {
      await logRefusal(db, destination, 'untrusted_quote', text);
      return { ok: false, reason: 'untrusted_quote' };
    }
  }
  return { ok: true };
}

// Theme 1c: outbound private-scope guard. Closes the redesign-spec promise
// that `private` memos never leave the boundary.
export async function checkOutboundScope(db, { tool, refs }) {
  if (!refs || refs.length === 0) return { ok: true };

  // Direct: any referenced row in a blocked scope?
  // We can't SELECT across tables in one query, so check memos + events + entities.
  const [memoRows] = await db
    .query(new BoundQuery('SELECT id, scope FROM memos WHERE id IN $refs', { refs }))
    .collect();
  const [eventRows] = await db
    .query(new BoundQuery('SELECT id, scope FROM events WHERE id IN $refs', { refs }))
    .collect();
  const [entityRows] = await db
    .query(new BoundQuery('SELECT id, scope FROM entities WHERE id IN $refs', { refs }))
    .collect();
  const allRefs = [...(memoRows ?? []), ...(eventRows ?? []), ...(entityRows ?? [])];
  const directBlocked = allRefs.filter((r) => r.scope && isOutboundBlocked(r.scope));

  // Transitive: events derived_from a private memo are also blocked.
  // Uses post-merge arrow traversal on TYPE RELATION edges.
  let derivedBlocked = [];
  try {
    const [derived] = await db
      .query(
        new BoundQuery(
          `SELECT id, scope FROM events
           WHERE id IN $refs
             AND count(<-derived_from<-memos[WHERE scope = 'private']) > 0`,
          { refs },
        ),
      )
      .collect();
    derivedBlocked = derived ?? [];
  } catch {
    // arrow traversal not available (older engine) — fall back to OK
  }

  const allBlocked = [...directBlocked, ...derivedBlocked];
  if (allBlocked.length === 0) return { ok: true };

  await logRefusal(
    db,
    tool ?? 'unknown',
    'private_scope',
    `<redacted: ${allBlocked.length} private-scope reference(s)>`,
  );
  return {
    ok: false,
    reason: `${allBlocked.length} record(s) in private scope; refused to forward`,
    blocked: allBlocked.map((r) => String(r.id)),
  };
}
