// src/mcp/tools/ingest.js
import { existsSync, readFileSync, statSync } from 'node:fs';
import { surql } from 'surrealdb';
import { RobinPiiRefusedError } from '../../capture/errors.js';
import { recordEvent } from '../../capture/record-event.js';
import { guardInboundContent } from '../../hooks/inbound-guard.js';
import { buildIngestPrompt } from '../../jobs/ingest-prompt.js';
import { resolveOrCreateEntity } from '../../jobs/ingest-resolver.js';
import { createKnowledge } from '../../memory/knowledge.js';

const MAX_BYTES = 1_048_576;
const URL_FETCH_TIMEOUT_MS = 30_000;
const ALLOWED_CONTENT_TYPES = /^(text\/|application\/json)/;
const VALID_EDGE_KINDS = new Set([
  'mentions',
  'about',
  'works_on',
  'participates_in',
  'co_occurs_with',
]);

async function acquireContent({ content, url, file_path }) {
  if (content !== undefined) {
    if (content.length > MAX_BYTES)
      return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: content.length } };
    return { content, source_kind: 'inline', source_ref: null };
  }
  if (url !== undefined) {
    const res = await fetch(url, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: { reason: 'fetch_failed', status: res.status } };
    const ct = res.headers.get('content-type') ?? '';
    if (!ALLOWED_CONTENT_TYPES.test(ct))
      return { error: { reason: 'unsupported_content_type', content_type: ct } };
    const body = await res.text();
    if (body.length > MAX_BYTES)
      return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: body.length } };
    return { content: body, source_kind: 'url', source_ref: url };
  }
  if (file_path !== undefined) {
    if (!existsSync(file_path)) return { error: { reason: 'not_found' } };
    const st = statSync(file_path);
    if (!st.isFile()) return { error: { reason: 'not_a_file' } };
    if (st.size > MAX_BYTES)
      return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: st.size } };
    return { content: readFileSync(file_path, 'utf8'), source_kind: 'file', source_ref: file_path };
  }
  return { error: { reason: 'missing_arg' } };
}

export function createIngestTool({ db, embedder, host }) {
  return {
    name: 'ingest',
    description:
      'Write a source document into events + entities + edges + knowledge. User-triggered only.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        url: { type: 'string' },
        file_path: { type: 'string' },
      },
    },
    handler: async (input = {}) => {
      const provided = ['content', 'url', 'file_path'].filter((k) => input[k] !== undefined);
      if (provided.length === 0) return { ok: false, reason: 'missing_arg' };
      if (provided.length > 1) return { ok: false, reason: 'ambiguous_input' };

      const acquired = await acquireContent(input);
      if (acquired.error) return { ok: false, ...acquired.error };
      const { content, source_kind, source_ref } = acquired;

      // Record event (with inbound PII guard). RobinPiiRefusedError thrown on match.
      let eventResult;
      try {
        eventResult = await recordEvent(db, embedder, {
          source: 'ingest',
          content,
          meta: { kind: 'document', source_kind, source_ref },
          guard: guardInboundContent,
        });
      } catch (e) {
        if (e instanceof RobinPiiRefusedError) {
          return { ok: false, reason: `pii:${e.reason}` };
        }
        throw e;
      }

      const event_id = eventResult.id; // raw SurrealDB RecordId — needed for RELATE + source_events
      const event_id_str = String(event_id);

      // Dedup: recordEvent doesn't deduplicate — detect by querying how many
      // events share the same content_hash. If >1, this call is a duplicate.
      const { sha256 } = await import('../../embed/hash.js');
      const content_hash = sha256(content);
      const [dupeRows] = await db
        .query(surql`SELECT id FROM events WHERE content_hash = ${content_hash}`)
        .collect();
      const isDedup = Array.isArray(dupeRows) && dupeRows.length > 1;

      if (isDedup) {
        return { ok: true, deduped: true, event_id: event_id_str };
      }

      if (!host?.invokeLLM) return { ok: false, reason: 'no_host' };
      const llm = await host.invokeLLM([{ role: 'user', content: buildIngestPrompt(content) }], {
        tier: 'deep',
      });
      let parsed;
      try {
        parsed = JSON.parse(llm?.content ?? '');
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      } catch (e) {
        return { ok: false, reason: 'extraction_failed', detail: e.message };
      }

      const entitiesCreatedBefore =
        (await db.query(surql`SELECT count() AS n FROM entities GROUP ALL`).collect())[0]?.[0]?.n ??
        0;
      const entityIds = {};
      for (const e of parsed.entities ?? []) {
        if (!e?.name || !e?.type) continue;
        const id = await resolveOrCreateEntity(db, embedder, e);
        entityIds[e.name.toLowerCase()] = id;
      }
      const entitiesCreatedAfter =
        (await db.query(surql`SELECT count() AS n FROM entities GROUP ALL`).collect())[0]?.[0]?.n ??
        0;
      const entities_created = entitiesCreatedAfter - entitiesCreatedBefore;

      let edges_created = 0;
      for (const edge of parsed.edges ?? []) {
        if (!edge?.kind || !VALID_EDGE_KINDS.has(edge.kind)) {
          console.warn(`[ingest] skipping unknown edge kind: ${edge?.kind}`);
          continue;
        }
        const src = entityIds[edge.src_name?.toLowerCase?.()];
        const dst = entityIds[edge.dst_name?.toLowerCase?.()];
        if (!src || !dst) continue;
        try {
          await db
            .query(
              `RELATE ${event_id_str}->${edge.kind}->${String(dst)} CONTENT ${JSON.stringify(edge.meta ?? {})}`,
            )
            .collect();
          edges_created += 1;
        } catch (e) {
          console.warn(`[ingest] edge create failed: ${e.message}`);
        }
      }

      let knowledge_created = 0;
      for (const k of parsed.knowledge ?? []) {
        if (!k?.content) continue;
        const subject_id = k.subject_name ? entityIds[k.subject_name.toLowerCase()] : null;
        const result = await createKnowledge(db, embedder, {
          content: k.content,
          subject_id: subject_id ?? null,
          confidence: typeof k.confidence === 'number' ? k.confidence : 0.5,
          source_events: [event_id], // raw RecordId — SurrealDB expects record<events>
          source_episodes: [],
        });
        if (result?.id) knowledge_created += 1;
      }

      return {
        ok: true,
        deduped: false,
        event_id: event_id_str,
        entities_created,
        edges_created,
        knowledge_created,
      };
    },
  };
}
