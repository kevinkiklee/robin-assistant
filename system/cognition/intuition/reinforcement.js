// reinforcement.js — the recall-feedback loop.
//
// Phase 3 batching: 200 pending rows × (1 correction + N hit-updates + 1
// outcome update) collapses from ~1200 queries to ~7 by:
//   1. One pre-fetch for all correction events in the union window.
//   2. Bucket memo reinforcements by hit-count (preserves the "memo hit in
//      N pending rows → signal_count += N" semantics).
//   3. One UPDATE per outcome bucket on recall_log.

import { BoundQuery, surql } from 'surrealdb';
import { attribute } from './attribute.js';
import { readReinforcementConfig } from './reinforcement-config.js';

const REINFORCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Coerce row.ts / event.ts (Date | string | number) to milliseconds once.
// Used throughout the B1 pre-pass so the
// (instanceof Date ? .getTime() : new Date().getTime()) idiom doesn't
// proliferate.
function tsMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  return new Date(x).getTime();
}

function hitRecordId(hit) {
  // Tolerate legacy field names; the canonical field is `record`.
  const v = hit.record ?? hit.memo_id ?? hit.event_id ?? hit.record_id;
  if (!v) return null;
  return typeof v === 'string' ? v : String(v);
}

function dominantUsedVia(hits) {
  const order = ['explicit', 'citation', 'similarity'];
  for (const v of order) if (hits.some((h) => h.used === true && h.used_via === v)) return v;
  return null;
}

function mkAttribution({ mode, total, used_count, dropped_hits, elapsed_ms, config }) {
  return {
    mode,
    used_count,
    total,
    similarity_threshold: config.similarity_threshold,
    jaccard_min_overlap_tokens: config.jaccard_min_overlap_tokens,
    dropped_hits,
    elapsed_ms,
  };
}

/**
 * Evaluate all pending recall_log rows whose ts < now - REINFORCE_WINDOW_MS.
 * Idempotent: only acts on rows with outcome='pending'.
 *
 * @returns {{ evaluated: number, reinforced: number, corrected: number, no_signal: number }}
 */
export async function evaluatePending(db) {
  const cutoff = new Date(Date.now() - REINFORCE_WINDOW_MS);
  const [pending] = await db
    .query(
      surql`SELECT id, session_id, ts, ranked_hits
            FROM recall_log
            WHERE outcome = 'pending' AND ts < ${cutoff}
            ORDER BY ts ASC
            LIMIT 200`,
    )
    .collect();

  const summary = { evaluated: 0, reinforced: 0, corrected: 0, no_signal: 0, no_used: 0 };
  if (!pending || pending.length === 0) return summary;

  // B1: per-tick reinforcement config (kill switch + thresholds).
  const config = await readReinforcementConfig(db);

  // Phase 3 step 1: one pre-fetch for ALL correction events in the union
  // window. Index `events_meta_kind` (added in Phase 1) keeps this O(log n).
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const row of pending) {
    const ts = tsMs(row.ts);
    if (ts < minStart) minStart = ts;
    const end = ts + REINFORCE_WINDOW_MS;
    if (end > maxEnd) maxEnd = end;
  }
  const [corrections] = await db
    .query(
      surql`SELECT ts, meta.session_id AS sid
            FROM events
            WHERE meta.kind = 'correction'
              AND ts >= ${new Date(minStart)}
              AND ts <= ${new Date(maxEnd)}`,
    )
    .collect();

  // B1 §3.1: batched reply-event lookup (one SELECT over the union window).
  // Conversation events with ts >= recall.ts and ts <= recall.ts + reply_window
  // are candidate replies. Bucketed by session for pairing below.
  let candidates = [];
  if (config.attribution_mode !== 'off' && pending.length > 0) {
    const tsValues = pending.map((r) => tsMs(r.ts));
    const minTs = new Date(Math.min(...tsValues));
    const maxTs = new Date(Math.max(...tsValues) + config.reply_lookup_window_ms);
    const [rows] = await db
      .query(
        surql`SELECT id, content, ts, meta.session_id AS sid
              FROM events
              WHERE source = 'conversation'
                AND ts >= ${minTs}
                AND ts <= ${maxTs}
              ORDER BY ts ASC`,
      )
      .collect();
    candidates = rows ?? [];
  }

  // Bucket candidates by session id (string), with '__null__' for null sids.
  const candidatesBySid = new Map();
  for (const e of candidates) {
    const key = e.sid ?? '__null__';
    if (!candidatesBySid.has(key)) candidatesBySid.set(key, []);
    candidatesBySid.get(key).push(e);
  }

  // Pair pending rows with reply candidates using the section 7.3 mitigation:
  // sort pending by (sid, ts); advance a cursor per bucket; first in-window
  // candidate (but not past the next pending row's ts in the same bucket)
  // belongs to the current row.
  const replyByRowId = new Map();
  if (config.attribution_mode !== 'off') {
    const grouped = new Map();
    for (const r of pending) {
      const key = r.session_id ?? '__null__';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    for (const [sid, rows] of grouped.entries()) {
      rows.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
      const bucket = candidatesBySid.get(sid) ?? candidatesBySid.get('__null__') ?? [];
      let cursor = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rTs = tsMs(r.ts);
        const nextRTs = i + 1 < rows.length ? tsMs(rows[i + 1].ts) : Number.POSITIVE_INFINITY;
        const maxReplyTs = Math.min(rTs + config.reply_lookup_window_ms, nextRTs);
        while (cursor < bucket.length) {
          const t = tsMs(bucket[cursor].ts);
          if (t < rTs) {
            cursor++;
            continue;
          }
          if (t > maxReplyTs) break;
          replyByRowId.set(String(r.id), bucket[cursor]);
          cursor++;
          break;
        }
      }
    }
  }

  // Bucket corrections by session id (null for global-session corrections).
  const correctionsBySession = new Map();
  for (const c of corrections ?? []) {
    const ts = (c.ts instanceof Date ? c.ts : new Date(c.ts)).getTime();
    const key = c.sid ?? '__null__';
    if (!correctionsBySession.has(key)) correctionsBySession.set(key, []);
    correctionsBySession.get(key).push(ts);
  }
  const hasCorrectionInWindow = (sessionId, tsStart, tsEnd) => {
    const buckets = sessionId
      ? [correctionsBySession.get(sessionId), correctionsBySession.get('__null__')]
      : Array.from(correctionsBySession.values());
    for (const b of buckets) {
      if (!b) continue;
      for (const t of b) {
        if (t >= tsStart && t <= tsEnd) return true;
      }
    }
    return false;
  };

  // B1 §3.2: pre-compute which rows are corrected so the per-row attribute
  // pass can skip them. Promotes the per-row check out of the categorisation
  // loop because the attribute pre-pass needs to know it first.
  const correctedRowIds = new Set();
  for (const row of pending) {
    const ts = tsMs(row.ts);
    if (hasCorrectionInWindow(row.session_id, ts, ts + REINFORCE_WINDOW_MS)) {
      correctedRowIds.add(String(row.id));
    }
  }

  // B1 §3.2: two batched SELECTs hydrate ranked_hits[*].content/ts/meta so
  // attribute() can run similarity. Skipped entirely under mode='off'.
  const eventIds = new Set();
  const memoIds = new Set();
  if (config.attribution_mode !== 'off') {
    for (const row of pending) {
      for (const hit of row.ranked_hits ?? []) {
        const id = hitRecordId(hit);
        if (!id) continue;
        if (id.startsWith('events:')) eventIds.add(id);
        else if (id.startsWith('memos:')) memoIds.add(id);
      }
    }
  }
  const hydration = new Map();
  if (eventIds.size > 0) {
    try {
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT id, content, ts, meta FROM events
             WHERE id IN $ids.map(|$s| type::record('events', $s.slice($prefix.len())))`,
            { ids: Array.from(eventIds), prefix: 'events:' },
          ),
        )
        .collect();
      for (const r of rows ?? []) hydration.set(String(r.id), r);
    } catch (e) {
      console.warn(`[reinforce] event hydration failed: ${e.message}`);
    }
  }
  if (memoIds.size > 0) {
    try {
      const [rows] = await db
        .query(
          new BoundQuery(
            // memos do not carry `ts` (cf. inject.js: h.record.ts ?? h.record.derived_at).
            // Alias derived_at AS ts so the per-hit attribution pipeline sees a uniform
            // shape regardless of source table.
            `SELECT id, content, derived_at AS ts, meta FROM memos
             WHERE id IN $ids.map(|$s| type::record('memos', $s.slice($prefix.len())))`,
            { ids: Array.from(memoIds), prefix: 'memos:' },
          ),
        )
        .collect();
      for (const r of rows ?? []) hydration.set(String(r.id), r);
    } catch (e) {
      console.warn(`[reinforce] memo hydration failed: ${e.message}`);
    }
  }

  // B1 §3.2: per-row attribute() pass — populates row.attribution,
  // row.reply_event_id, and row.ranked_hits with used/used_via/used_score.
  for (const row of pending) {
    const rowIdStr = String(row.id);
    const tStart = Date.now();
    // Annotate hits with hydrated content for attribute()'s benefit.
    // Under mode='off' hydration is skipped (mode='off' does not consult
    // content), so we don't mark hits as hit_missing in that branch — they
    // are simply force-credited.
    const annotatedHits = (row.ranked_hits ?? []).map((h) => {
      const id = hitRecordId(h);
      const src = id ? hydration.get(id) : null;
      if (!src) {
        if (config.attribution_mode === 'off') {
          return { ...h };
        }
        return { ...h, used: false, used_via: 'hit_missing' };
      }
      return { ...h, content: src.content, ts: src.ts, meta: src.meta ?? h.meta };
    });
    const droppedHits = annotatedHits.filter((h) => h.used_via === 'hit_missing').length;

    if (correctedRowIds.has(rowIdStr)) {
      row.ranked_hits = annotatedHits.map(({ content: _c, ts: _t, ...rest }) => rest);
      row.attribution = mkAttribution({
        mode: 'corrected',
        total: annotatedHits.length,
        used_count: 0,
        dropped_hits: droppedHits,
        elapsed_ms: Date.now() - tStart,
        config,
      });
      row.reply_event_id = null;
      continue;
    }
    if (annotatedHits.length === 0) {
      row.attribution = mkAttribution({
        mode: 'no_hits',
        total: 0,
        used_count: 0,
        dropped_hits: 0,
        elapsed_ms: Date.now() - tStart,
        config,
      });
      row.reply_event_id = null;
      continue;
    }
    if (config.attribution_mode === 'off') {
      for (const h of annotatedHits) {
        if (h.used_via === 'hit_missing') continue;
        h.used = true;
        h.used_via = 'off';
      }
      row.ranked_hits = annotatedHits.map(({ content: _c, ts: _t, ...rest }) => rest);
      row.attribution = mkAttribution({
        mode: 'off',
        total: annotatedHits.length,
        used_count: annotatedHits.filter((h) => h.used === true).length,
        dropped_hits: droppedHits,
        elapsed_ms: Date.now() - tStart,
        config,
      });
      row.reply_event_id = null;
      continue;
    }

    const reply = replyByRowId.get(rowIdStr) ?? null;
    const replyBody = reply?.content ?? '';
    const hasBody = replyBody.includes('\n\nASSISTANT: ')
      ? replyBody.slice(replyBody.indexOf('\n\nASSISTANT: ') + '\n\nASSISTANT: '.length).trim()
          .length > 0
      : false;

    if (!reply || !hasBody) {
      if (config.fallback_when_no_reply) {
        for (const h of annotatedHits) {
          if (h.used_via === 'hit_missing') continue;
          h.used = true;
          h.used_via = 'fallback';
        }
      } else {
        for (const h of annotatedHits) if (h.used_via !== 'hit_missing') h.used = false;
      }
      row.ranked_hits = annotatedHits.map(({ content: _c, ts: _t, ...rest }) => rest);
      row.attribution = mkAttribution({
        mode: 'fallback_no_reply',
        total: annotatedHits.length,
        used_count: annotatedHits.filter((h) => h.used === true).length,
        dropped_hits: droppedHits,
        elapsed_ms: Date.now() - tStart,
        config,
      });
      row.reply_event_id = reply?.id ?? null;
      continue;
    }

    // Run pure attribute() pass.
    const scored = attribute(annotatedHits, replyBody, config);
    let used_count = scored.filter((h) => h.used === true).length;
    let mode;
    if (used_count === 0 && config.fallback_when_zero_used) {
      for (const h of scored) {
        if (h.used_via === 'hit_missing') continue;
        h.used = true;
        h.used_via = 'fallback';
      }
      used_count = scored.filter((h) => h.used === true).length;
      mode = 'fallback_zero_used';
    } else if (used_count === 0) {
      mode = 'fallback_zero_used';
    } else {
      mode = dominantUsedVia(scored) ?? 'similarity';
    }
    row.attribution = mkAttribution({
      mode,
      total: scored.length,
      used_count,
      dropped_hits: droppedHits,
      elapsed_ms: Date.now() - tStart,
      config,
    });
    row.ranked_hits = scored.map(({ content: _c, ts: _t, ...rest }) => rest);
    row.reply_event_id = reply.id;
  }

  // B1 §3.3: categorise pending rows + build the reinforcement count map.
  // Filter on hit.used === true ONLY. This is the load-bearing B1 change.
  // We keep the record-ref form of `row.id` (not stringified) so the bucketed
  // `WHERE id IN $ids` UPDATE can match by record identity.
  const outcomesByRow = []; // [{ id: <record>, outcome }]
  const memoHitCount = new Map(); // "memos:X" -> times-recalled-in-window
  for (const row of pending) {
    summary.evaluated += 1;
    const rowIdStr = String(row.id);
    if (correctedRowIds.has(rowIdStr)) {
      outcomesByRow.push({ id: row.id, outcome: 'corrected' });
      summary.corrected += 1;
      continue;
    }
    if (!row.ranked_hits || row.ranked_hits.length === 0) {
      outcomesByRow.push({ id: row.id, outcome: 'evaluated_no_signal' });
      summary.no_signal += 1;
      continue;
    }
    // §7.10: dedup duplicate-hit-in-ranked_hits by record id so signal_count
    // bumps by 1 per distinct memo per pending row, not per ranked_hits entry.
    let usedHits = 0;
    const seenIds = new Set();
    for (const hit of row.ranked_hits) {
      if (hit.used !== true) continue;
      usedHits++;
      const id = hitRecordId(hit);
      if (!id?.startsWith('memos:')) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      memoHitCount.set(id, (memoHitCount.get(id) ?? 0) + 1);
    }
    if (usedHits === 0) {
      outcomesByRow.push({ id: row.id, outcome: 'evaluated_no_used' });
      summary.no_used += 1;
    } else {
      outcomesByRow.push({ id: row.id, outcome: 'reinforced' });
      summary.reinforced += 1;
    }
  }

  // Theme 2a: emit refute ledger rows for memos in corrected rows.
  // Theme 3: emit a reflection trigger for each corrected row.
  // (`correctedRowIds` Set is pre-built before the attribute pass; here we
  // collect the corresponding record refs for downstream emission.)
  const correctedMemoIds = new Set();
  const correctedRowRecords = [];
  for (const row of pending) {
    if (!correctedRowIds.has(String(row.id))) continue;
    correctedRowRecords.push(row.id);
    for (const hit of row.ranked_hits ?? []) {
      const id = hitRecordId(hit);
      if (!id?.startsWith('memos:')) continue;
      correctedMemoIds.add(id);
    }
  }
  for (const rid of correctedRowRecords) {
    try {
      await db
        .query(
          new BoundQuery(
            `CREATE dream_triggers CONTENT { step: 'reflection', reason: 'correction_landed', source_id: $sid }`,
            { sid: rid },
          ),
        )
        .collect();
    } catch (e) {
      console.warn(`[reinforce] trigger emit failed: ${e.message}`);
    }
  }
  for (const idStr of correctedMemoIds) {
    try {
      await db
        .query(
          new BoundQuery(
            `CREATE evidence_ledger CONTENT {
              memo_id: type::record('memos', $key),
              polarity: 'refutes',
              reason: 'correction',
              weight: 1.0
            }`,
            { key: idStr.slice('memos:'.length) },
          ),
        )
        .collect();
    } catch (e) {
      if (!String(e?.message ?? '').includes('does not exist')) {
        console.warn(`[reinforce] evidence-refute failed for ${idStr}: ${e.message}`);
      }
    }
  }

  // Theme 2a + B1: emit corroborates ledger rows. weight=N where N is the
  // number of pending rows in this batch where the memo was both injected
  // AND used (per-hit attribution from section 3, filtered in section 4).
  for (const [idStr, n] of memoHitCount.entries()) {
    try {
      await db
        .query(
          new BoundQuery(
            `CREATE evidence_ledger CONTENT {
              memo_id: type::record('memos', $key),
              polarity: 'corroborates',
              reason: 'reinforcement',
              weight: $w
            }`,
            { key: idStr.slice('memos:'.length), w: n },
          ),
        )
        .collect();
    } catch (e) {
      if (!String(e?.message ?? '').includes('does not exist')) {
        console.warn(`[reinforce] evidence-corroborate failed for ${idStr}: ${e.message}`);
      }
    }
  }

  // Phase 3 step 2: bucket memo updates by count. One UPDATE per distinct count.
  // Memos recalled in N pending rows get signal_count += N (regression guard
  // gate 12 in scripts/verify-design-assumptions.js).
  const byCount = new Map(); // count -> array of memo:id strings
  for (const [id, n] of memoHitCount.entries()) {
    if (!byCount.has(n)) byCount.set(n, []);
    byCount.get(n).push(id);
  }
  for (const [n, ids] of byCount.entries()) {
    try {
      // Use array::map(...) server-side to build record refs from the string
      // keys, then UPDATE WHERE id IN that set. One round-trip per bucket.
      await db
        .query(
          new BoundQuery(
            `UPDATE memos
             SET signal_count += $n, decay_anchor = time::now()
             WHERE id IN $ids.map(|$s| type::record('memos', $s.slice($prefix.len())))`,
            { n, ids, prefix: 'memos:' },
          ),
        )
        .collect();
    } catch (e) {
      // Silent "does not exist" is expected (memo could have been deleted);
      // anything else is a real error worth surfacing.
      if (!String(e?.message ?? '').includes('does not exist')) {
        console.warn(`[reinforce] batch update failed (count=${n}): ${e.message}`);
      }
    }
  }

  // B1 §3.4: per-row UPDATE with the post-attribution payload. One
  // multi-statement query, one round-trip per tick. Sent only when at least
  // one row has new payload to write. Each $attr_${i} below is the FULL §1
  // attribution object produced by mkAttribution() above — never a subset.
  const rowsWithPayload = pending.filter(
    (r) => r.attribution !== undefined || r.reply_event_id !== undefined,
  );
  if (rowsWithPayload.length > 0) {
    const parts = [];
    const params = {};
    rowsWithPayload.forEach((r, i) => {
      // reply_event_id is `option<record<events>>` — bind NONE literally when
      // the row has no paired reply rather than NULL (Surreal rejects NULL on
      // a `option<record<...>>` field). attribution is FLEXIBLE so NULL is
      // acceptable there.
      const ridLiteral = r.reply_event_id ? `$rid_${i}` : 'NONE';
      parts.push(
        `UPDATE $row_${i} SET ranked_hits = $hits_${i}, attribution = $attr_${i}, reply_event_id = ${ridLiteral};`,
      );
      params[`row_${i}`] = r.id;
      params[`hits_${i}`] = r.ranked_hits;
      params[`attr_${i}`] = r.attribution ?? null;
      if (r.reply_event_id) params[`rid_${i}`] = r.reply_event_id;
    });
    try {
      await db.query(new BoundQuery(parts.join('\n'), params)).collect();
    } catch (e) {
      console.warn(`[reinforce] attribution UPDATE failed: ${e.message}`);
    }
  }

  // Phase 3 step 3: one UPDATE per outcome bucket on recall_log.
  const idsByOutcome = {
    reinforced: [],
    corrected: [],
    evaluated_no_signal: [],
    evaluated_no_used: [],
  };
  for (const r of outcomesByRow) idsByOutcome[r.outcome].push(r.id);
  for (const outcome of Object.keys(idsByOutcome)) {
    if (idsByOutcome[outcome].length === 0) continue;
    try {
      await db
        .query(
          new BoundQuery(
            `UPDATE recall_log SET outcome = $o, evaluated_at = time::now()
             WHERE id IN $ids`,
            { o: outcome, ids: idsByOutcome[outcome] },
          ),
        )
        .collect();
    } catch (e) {
      console.warn(`[reinforce] outcome update failed (${outcome}): ${e.message}`);
    }
  }

  return summary;
}
