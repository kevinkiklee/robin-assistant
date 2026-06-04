/**
 * Embed policy — which event kinds get a semantic (vector) embedding.
 *
 * recall() runs a brute-force vec0 KNN over EVERY embedded row (sqlite-vec has no
 * ANN index), so latency and storage scale linearly with the embedded corpus.
 * High-volume operational/log/integration records (a $40 lunch_money line item, a
 * Spotify play, an integration tick, a hook-receipt) add cost and noise to that
 * scan while carrying little semantic-recall value — they compete in nearest-
 * neighbor space against curated knowledge and beliefs.
 *
 * Denied kinds are still ingested as events and remain FTS-searchable via
 * events_content; only the vector embedding is skipped. Recall over them still
 * works lexically. This is the single highest-leverage lever for both recall
 * speed and DB size: skipping ~20k noise vectors shrinks the KNN scan set
 * proportionally.
 */

/** Exact event kinds that must NOT be vectorized. (`*.tick` is handled separately.) */
export const NO_EMBED_KINDS: ReadonlySet<string> = new Set([
  // Operational acks / lifecycle — not memories.
  'invariant.check',
  'daemon.start',
  'daemon.shutdown',
  // High-frequency, low-recall-value integration records.
  'integration.chrome.visit',
  'v2.lunch_money',
  'lunch_money.transaction',
  'lunch_money.account_snapshot',
  'spotify_played',
  'spotify_top_track',
  'spotify_top_artist',
  'v2.spotify',
]);

/** True when an event of `kind` should receive a vector embedding. */
export function shouldEmbed(kind: string): boolean {
  if (NO_EMBED_KINDS.has(kind)) return false;
  // Any integration heartbeat (`integration.tick`, `integration.finance_quote.tick`,
  // and any future `*.tick`) is a periodic ack, never recall-worthy.
  if (kind.endsWith('.tick')) return false;
  return true;
}

/**
 * SQL predicate (+ bound params) selecting rows whose kind IS embeddable, for use
 * in the embedder eligibility query. `col` is the qualified kind column, e.g.
 * `e.kind`. Mirrors {@link shouldEmbed} so the embedder and the pure predicate
 * can never drift.
 */
export function embeddableKindSql(col = 'kind'): { sql: string; params: string[] } {
  const params = [...NO_EMBED_KINDS];
  const placeholders = params.map(() => '?').join(',');
  return {
    sql: `(${col} NOT IN (${placeholders}) AND ${col} NOT LIKE '%.tick')`,
    params,
  };
}

/**
 * SQL predicate (+ bound params) selecting rows whose kind is DENIED (the logical
 * inverse of {@link embeddableKindSql}). Used in `NOT EXISTS` eligibility clauses
 * and the noise-vector prune.
 */
export function deniedKindSql(col = 'kind'): { sql: string; params: string[] } {
  const params = [...NO_EMBED_KINDS];
  const placeholders = params.map(() => '?').join(',');
  return {
    sql: `(${col} IN (${placeholders}) OR ${col} LIKE '%.tick')`,
    params,
  };
}
