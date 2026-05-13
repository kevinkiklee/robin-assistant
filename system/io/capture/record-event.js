import { BoundQuery, surql } from 'surrealdb';
import { sha256 } from '../../data/embed/hash.js';
import { activeProfile, embeddingTable } from '../../data/embed/profile-router.js';
import { RobinPiiRefusedError } from './errors.js';

const VALID_SOURCES = new Set([
  'cli',
  'stop_hook',
  'manual',
  'sync',
  'biographer',
  'ingest',
  'discord',
  'migration',
  'conversation',
]);

export async function recordEvent(db, embedder, input) {
  const { source, content, ts, meta, external_id, guard } = input;
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`recordEvent: unknown source "${source}"`);
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('recordEvent: content must be a non-empty string');
  }

  // Inbound PII guard. Optional — callers that didn't opt in (existing CLI
  // ingest, sync, biographer pipelines, migration) keep their existing
  // behavior. MCP memory-write tools wire `guardInboundContent` explicitly.
  if (typeof guard === 'function') {
    const verdict = await guard(db, content);
    if (verdict && verdict.ok === false) {
      throw new RobinPiiRefusedError(verdict.reason);
    }
  }

  const content_hash = sha256(content);
  const tsValue = ts ? new Date(ts) : undefined;

  // The events schema dropped its top-level `external_id` column; integration
  // callers may still pass it at the top level for ergonomics — normalize into
  // `meta.external_id` so downstream queries (and dedupe) keep working.
  const normalizedMeta = external_id != null ? { ...(meta ?? {}), external_id } : meta;

  const set = {
    source,
    content,
    content_hash,
    ...(tsValue ? { ts: tsValue } : {}),
    ...(normalizedMeta ? { meta: normalizedMeta } : {}),
  };

  const [created] = await db.query(surql`CREATE events CONTENT ${set}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  const eventId = row.id;

  // Write embedding into the active profile's per-surface embeddings table.
  // Embedding lookups go through embeddings_<profile>_events; record-event
  // remains the only writer for the events firehose.
  //
  // Embedding failure must not lose the event. Mirror the resilience pattern
  // used by integration capture (io/integrations/_framework/capture.js): the
  // event row is already created above; if the embedder is mis-configured or
  // produces a vector that the active table's schema rejects, log a warning
  // and return success. Recall via semantic search will be degraded until the
  // profile mismatch is fixed and the row is back-filled, but writes (the
  // memory-write tools — remember, ingest, record_correction, etc.) keep
  // working instead of bubbling InternalError to MCP clients.
  try {
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
  } catch (e) {
    console.warn(`recordEvent: embedding failed for ${eventId}: ${e.message}`);
  }

  return { id: eventId };
}
