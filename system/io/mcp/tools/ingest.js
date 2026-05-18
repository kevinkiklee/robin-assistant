// src/mcp/tools/ingest.js
//
//   - Edge writes go through `store.relateAll` against the unified edges table.
//   - Entity upserts go through `store.upsertEntity` (3-stage cascade in
//     biographer/upsert-entity.js).
//   - Knowledge memos are created via `store.note('knowledge', …)` with the
//     spec-shaped lineage `[{id, kind: 'event'}]`; createKnowledge thin lens
//     also delegates to store.note.
//   - Edge-kind vocabulary maps the LLM's legacy aliases to EDGE_KIND_REGISTRY
//     kinds (co_occurs_with → occurs_with, precedes → before).

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { surql } from 'surrealdb';
import { checkDurableWrite } from '../../../cognition/discretion/durable-write.js';
import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';
import { buildIngestPrompt } from '../../../cognition/jobs/ingest-prompt.js';
import * as store from '../../../cognition/memory/store.js';
import { sha256 } from '../../../data/embed/hash.js';
import { getSessionTaint } from '../../../runtime/mcp/session-taint.js';
import { RobinPiiRefusedError } from '../../capture/errors.js';
import { recordEvent } from '../../capture/record-event.js';

const MAX_BYTES = 1_048_576;
const URL_FETCH_TIMEOUT_MS = 30_000;
const ALLOWED_CONTENT_TYPES = /^(text\/|application\/json)/;

// Edge kinds accepted from the ingest LLM. Legacy aliases map onto the new
// EDGE_KIND_REGISTRY kinds; `before` is event→event only (`from` is the new
// event for any edge whose source is an event).
const EDGE_KIND_MAP = {
  mentions: 'mentions',
  about: 'about',
  works_on: 'works_on',
  participates_in: 'participates_in',
  occurs_with: 'occurs_with',
  co_occurs_with: 'occurs_with',
  before: 'before',
  precedes: 'before',
};
const EVENT_SOURCED_KINDS = new Set(['mentions', 'about', 'before']);

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
    // Resolve symlinks before the boundary check — a symlink at ~/x → /etc/passwd
    // would otherwise pass the prefix check and read the linked target.
    // realpathSync also canonicalises ../ traversal.
    let resolved;
    try {
      resolved = realpathSync(resolvePath(file_path));
    } catch {
      return { error: { reason: 'not_found' } };
    }
    const home = realpathSync(homedir());
    if (resolved !== home && !resolved.startsWith(`${home}/`)) {
      return { error: { reason: 'outside_home', resolved } };
    }
    const st = statSync(resolved);
    if (!st.isFile()) return { error: { reason: 'not_a_file' } };
    if (st.size > MAX_BYTES)
      return { error: { reason: 'too_large', max_bytes: MAX_BYTES, given: st.size } };
    return { content: readFileSync(resolved, 'utf8'), source_kind: 'file', source_ref: resolved };
  }
  return { error: { reason: 'missing_arg' } };
}

export function createIngestTool({ db, embedder, host, getSessionId }) {
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
        source_trust: { type: 'string', enum: ['trusted', 'untrusted'] },
        force: { type: 'boolean', default: false },
      },
    },
    handler: async (input = {}) => {
      const provided = ['content', 'url', 'file_path'].filter((k) => input[k] !== undefined);
      if (provided.length === 0) return { ok: false, reason: 'missing_arg' };
      if (provided.length > 1) return { ok: false, reason: 'ambiguous_input' };

      const acquired = await acquireContent(input);
      if (acquired.error) return { ok: false, ...acquired.error };
      const { content, source_kind, source_ref } = acquired;

      // Dedup check FIRST (§3.2): avoid phantom event + wasted embedder cost on re-ingest.
      const content_hash = sha256(content);
      const [existingRows] = await db
        .query(surql`SELECT id FROM events WHERE content_hash = ${content_hash}`)
        .collect();
      if (Array.isArray(existingRows) && existingRows.length > 0) {
        return { ok: true, deduped: true, event_id: String(existingRows[0].id) };
      }

      // Resolve trust: explicit override > session taint > default trusted.
      const sessionId = getSessionId?.() ?? null;
      const taint = getSessionTaint(sessionId);
      const trust = input.source_trust ?? (taint.tainted ? 'untrusted' : 'trusted');

      // Outbound durable-write gate (PII/secret/verbatim; taint NOT applied for ingest).
      const gate = await checkDurableWrite(db, {
        destination: 'ingest',
        text: content,
        sessionTaint: taint,
        force: input.force === true,
      });
      if (!gate.ok) {
        return { ok: false, reason: 'outbound_blocked', blocked_by: gate.reason };
      }

      // Record event (with inbound PII guard). RobinPiiRefusedError thrown on match.
      let eventResult;
      try {
        eventResult = await recordEvent(db, embedder, {
          source: 'ingest',
          content,
          meta: { kind: 'document', source_kind, source_ref },
          trust,
          guard: guardInboundContent,
        });
      } catch (e) {
        if (e instanceof RobinPiiRefusedError) {
          return { ok: false, reason: `pii:${e.reason}` };
        }
        throw e;
      }

      const event_id = eventResult.id;
      const event_id_str = String(event_id);

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
        const r = await store.upsertEntity(db, embedder, {
          name: e.name,
          type: e.type,
          host,
          meta: e.aliases?.length ? { aliases: e.aliases } : undefined,
        });
        entityIds[e.name.toLowerCase()] = r.id;
      }
      const entitiesCreatedAfter =
        (await db.query(surql`SELECT count() AS n FROM entities GROUP ALL`).collect())[0]?.[0]?.n ??
        0;
      const entities_created = entitiesCreatedAfter - entitiesCreatedBefore;

      // Collect edges, then emit via relateAll in one pass.
      const edgeRows = [];
      for (const edge of parsed.edges ?? []) {
        const kind = EDGE_KIND_MAP[edge?.kind];
        if (!kind) {
          console.warn(`[ingest] skipping unknown edge kind: ${edge?.kind}`);
          continue;
        }
        const src = entityIds[edge.src_name?.toLowerCase?.()];
        const dst = entityIds[edge.dst_name?.toLowerCase?.()];
        if (!dst) continue;
        // For event-sourced kinds (mentions / about / before), `from` is the
        // new event; for entity↔entity kinds, `from` is the src entity.
        const fromRec = EVENT_SOURCED_KINDS.has(kind) ? event_id : src;
        if (!fromRec) continue;
        edgeRows.push({ from: fromRec, to: dst, kind, meta: edge.meta });
      }
      let edges_created = 0;
      if (edgeRows.length > 0) {
        try {
          const { ids } = await store.relateAll(db, edgeRows);
          edges_created = ids.length;
        } catch (e) {
          console.warn(`[ingest] edge create failed: ${e.message}`);
        }
      }

      let knowledge_created = 0;
      for (const k of parsed.knowledge ?? []) {
        if (!k?.content) continue;
        const subjectId = k.subject_name ? entityIds[k.subject_name.toLowerCase()] : null;
        const result = await store.note(db, embedder, 'knowledge', {
          content: k.content,
          derived_by: 'ingest',
          confidence: typeof k.confidence === 'number' ? k.confidence : 0.5,
          subjects: subjectId ? [subjectId] : [],
          lineage: [{ id: event_id, kind: 'event' }],
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
