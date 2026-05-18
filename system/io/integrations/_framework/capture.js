import { BoundQuery, surql } from 'surrealdb';
import { SECRET_PATTERNS } from '../../../cognition/discretion/outbound-patterns.js';
import { sha256 } from '../../../data/embed/hash.js';
import { activeProfile, embeddingTable } from '../../../data/embed/profile-router.js';

// Allowed charset must match `cognition/memory/edge-registry.js`'s
// SAFE_ID_KEY = /^[A-Za-z0-9_]+$/. They WERE different historically —
// this sanitizer permitted hyphens while validateEdge rejected them — and
// the drift produced two systemic bugs:
//   (1) `daily-briefing.js` minted `daily_briefing_${YYYY-MM-DD}_${HH}`
//       external_ids that capture happily stored as readable row ids;
//       every subsequent biographer relateAll referencing those rows then
//       got skipped client-side (`relateAll[N]: skipping invalid edge —
//       from: unsafe id key '…'`), flooding daemon.log without ever
//       producing the intended `before` chain edges.
//   (2) Same shape would fire for any future integration whose external_id
//       embeds a hyphen — Google Drive file IDs, Letterboxd slugs, NHL
//       team codes. Keeping the two regexes aligned makes "if capture
//       accepts it, validateEdge accepts it" a checkable invariant.
//
// External_ids outside this set fall back to `h_<sha256[:24]>` — 24 hex
// chars / 96 bits is comfortably past birthday-collision risk for realistic
// row counts. The original readable form is preserved on the row's
// `meta.external_id` field, so recall-by-external_id queries against that
// field still work; only the surrogate row id loses its readability.
export function sanitizeIdPart(s) {
  return /^[A-Za-z0-9_]+$/.test(s) ? s : `h_${sha256(s).slice(0, 24)}`;
}

function deterministicId(source, external_id) {
  return `${source}__${sanitizeIdPart(external_id)}`;
}

async function writeEventEmbedding(db, embedder, eventId, content) {
  const profile = await activeProfile(db);
  const table = embeddingTable(profile, 'events');
  const vec = Array.from(await embedder.embed(content));
  await db
    .query(
      new BoundQuery(
        'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()',
        { tb: table, rec: eventId, vec },
      ),
    )
    .collect();
}

// Default inbound-content guard: refuse any row whose content carries a
// well-known secret shape (GitHub PAT, OpenAI/Anthropic keys, AWS access
// keys, Stripe live/test, etc.). The same regex set the outbound policy
// scans on its way out — applying it on capture keeps secret material out
// of `events.content` so a later recall + outbound write can never leak a
// token that was sitting in an inbox or chat the user never expected
// would land in the embedded store.
function defaultInboundGuard(_db, content) {
  if (typeof content !== 'string' || content.length === 0) return { ok: true };
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(content)) {
      return { ok: false, reason: `inbound_secret:${p.name}` };
    }
  }
  return { ok: true };
}

export function createCapture({ db, embedder, source, embed, mode, guard }) {
  // `guard === null` → caller explicitly opts out. `guard === undefined` →
  // default inbound-secret scanner. Any function → caller-supplied check.
  const activeGuard = guard === undefined ? defaultInboundGuard : guard;
  return async function capture(rows) {
    const result = { inserted: 0, skipped: 0, updated: 0, refused: 0, errors: [] };
    for (const row of rows) {
      try {
        if (activeGuard) {
          const verdict = await activeGuard(db, row.content);
          if (verdict && verdict.ok === false) {
            result.refused += 1;
            continue;
          }
        }
        const idKey = deterministicId(row.source ?? source, row.external_id);
        const tsValue = row.ts ? new Date(row.ts) : undefined;
        // The `events` schema dropped the inline `external_id` and `embedding`
        // columns in the redesign. Fold external_id into meta; write the
        // vector into embeddings_<profile>_events instead.
        const mergedMeta = { ...(row.meta ?? {}), external_id: row.external_id };
        const fields = {
          source: row.source ?? source,
          content: row.content,
          content_hash: sha256(row.content),
          // Integration data is external — default to `untrusted` so the
          // outbound verbatim-quote guard (outbound-policy.js) scans these
          // rows. Individual integrations may override (e.g. Robin's own
          // discord_dispatcher already passes `trust: 'untrusted'`); a future
          // first-party source can explicitly opt into `'trusted'` by setting
          // `row.trust` upstream.
          trust: row.trust ?? 'untrusted',
          meta: mergedMeta,
          ...(tsValue ? { ts: tsValue } : {}),
        };
        let eventId;
        let didWrite = false;
        if (mode === 'upsert') {
          const [ret] = await db
            .query(surql`UPSERT type::record('events', ${idKey}) MERGE ${fields}`)
            .collect();
          const r = Array.isArray(ret) ? ret[0] : ret;
          eventId = r?.id;
          result.updated += 1;
          didWrite = true;
        } else {
          const [exists] = await db
            .query(surql`SELECT id FROM type::record('events', ${idKey})`)
            .collect();
          if (exists.length > 0) {
            result.skipped += 1;
            continue;
          }
          const [ret] = await db
            .query(surql`CREATE type::record('events', ${idKey}) CONTENT ${fields}`)
            .collect();
          const r = Array.isArray(ret) ? ret[0] : ret;
          eventId = r?.id;
          result.inserted += 1;
          didWrite = true;
        }
        if (didWrite && embed && eventId) {
          try {
            await writeEventEmbedding(db, embedder, eventId, row.content);
          } catch (e) {
            console.warn(`capture: embedding failed for ${idKey}: ${e.message}`);
          }
        }
      } catch (e) {
        result.errors.push({ external_id: row.external_id, error: e.message });
      }
    }
    return result;
  };
}
