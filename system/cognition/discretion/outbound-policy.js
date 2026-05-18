import { BoundQuery } from 'surrealdb';
import { isOutboundBlocked } from '../memory/scope-registry.js';
import { PII_PATTERNS, SECRET_PATTERNS } from './outbound-patterns.js';
import { logRefusal } from './refusal-log.js';
import { scanForVerbatimQuote } from './verbatim-scan.js';

function logOutbound(db, destination, reason, payload) {
  return logRefusal(db, { direction: 'outbound', destination, reason, payload });
}

// True when `origin` is trusted under any prefix in `trustedOrigins`. Matches
// the v1 "Layer 1 trusted origins" model: an exact match, or a prefix that
// ends at a `:` boundary. So `discord:guild:G1` covers
// `discord:guild:G1:channel:C` and any thread under it, but won't accidentally
// trust `discord:guild:G1234`.
function isTrustedOrigin(origin, trustedOrigins) {
  if (!origin || !Array.isArray(trustedOrigins) || trustedOrigins.length === 0) {
    return false;
  }
  for (const allowed of trustedOrigins) {
    if (!allowed) continue;
    if (origin === allowed) return true;
    if (origin.startsWith(`${allowed}:`)) return true;
  }
  return false;
}

export async function checkOutbound(db, { destination, text, origin, trustedOrigins } = {}) {
  for (const p of PII_PATTERNS) {
    const m = p.regex.exec(text);
    if (m && (!p.mask || p.mask(m[0]))) {
      await logOutbound(db, destination, `pii:${p.name}`, text);
      return { ok: false, reason: `pii:${p.name}` };
    }
  }
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(text)) {
      await logOutbound(db, destination, `secret:${p.name}`, text);
      return { ok: false, reason: `secret:${p.name}` };
    }
  }
  // Verbatim-untrusted-quote guard is a Layer-1 taint check: it stops Robin
  // from echoing chunks of untrusted integration data (emails, browser titles,
  // calendar events) to third-party destinations. When the destination is the
  // user themselves (their own DM, their own personal server), echoing back is
  // the whole point — Robin's job is to summarize that data for them — so
  // skip this layer for trusted origins. PII + secret guards still applied above.
  if (isTrustedOrigin(origin ?? destination, trustedOrigins)) {
    return { ok: true };
  }
  const scan = await scanForVerbatimQuote(db, text);
  if (scan.found) {
    await logOutbound(db, destination, 'untrusted_quote', text);
    return { ok: false, reason: 'untrusted_quote' };
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

  await logOutbound(
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
