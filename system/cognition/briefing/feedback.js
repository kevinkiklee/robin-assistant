// cognition/briefing/feedback.js — record per-insight feedback for the brief.
//
// Insight ids in the brief are tagged [mN]. Feedback can come from three
// surfaces:
//   1. CLI: `robin brief feedback m3 bad`
//   2. Natural language: `record_correction` content contains "the m3 insight
//      wasn't useful" — this module exposes extractMNTokens for the parser
//   3. (Discord reactions intentionally dropped — too coarse for calibration)
//
// Each feedback writes an `events:insight_feedback__<...>` row tagged with the
// insight's category. The nightly `insight-calibration` job aggregates these
// into a per-category usefulness profile that the synthesis prompt reads.
//
// For `learned_*` category insights, feedback also acts on the underlying
// memory row: bad → rule pending-revocation; substantive correction → fresh
// record_correction against the rule.

import { surql } from 'surrealdb';

const VERDICTS = new Set(['good', 'bad', 'neutral']);

/**
 * Pull [mN] tokens out of free-text. Word-boundary regex avoids false
 * matches like "I1" or "ME" embedded in unrelated prose.
 *
 * @param {string} text
 * @returns {string[]} lowercase mN tokens e.g. ['m3', 'm7']
 */
export function extractMNTokens(text) {
  if (typeof text !== 'string') return [];
  const out = new Set();
  for (const match of text.matchAll(/\b[mM](\d{1,3})\b/g)) {
    out.add(`m${match[1]}`);
  }
  return [...out];
}

/**
 * Look up an insight by id in the most recent daily_briefing event.
 *
 * @param {any} db
 * @param {string} insightId — 'mN'
 * @returns {Promise<{ briefEventId: string, category: string, ref?: string, text: string } | null>}
 */
export async function findInsight(db, insightId) {
  const [rows] = await db
    .query(
      surql`SELECT id, ts, meta FROM events
            WHERE source = 'daily_briefing' AND meta.insights IS NOT NONE
            ORDER BY ts DESC LIMIT 1`,
    )
    .collect();
  const brief = rows[0];
  if (!brief?.meta?.insights) return null;
  const insights = brief.meta.insights;
  const found = scanInsights(insights, insightId);
  if (!found) return null;
  return { ...found, briefEventId: String(brief.id) };
}

function scanInsights(insights, id) {
  for (const w of insights.watching ?? []) {
    if (w.id === id) return { category: w.category, text: w.text, ref: w.ref };
  }
  for (const l of insights.learned ?? []) {
    if (l.id === id) return { category: l.category, text: l.text, ref: l.ref };
  }
  for (const [, s] of Object.entries(insights.section ?? {})) {
    if (s.id === id) return { category: s.category, text: s.text };
  }
  for (const s of insights.photo_critique?.supportive ?? []) {
    if (s.id === id) {
      return {
        category: s.category ?? 'photography_critique_supportive',
        text: s.text,
        photo_ref: s.photo_ref,
      };
    }
  }
  for (const i of insights.photo_critique?.improvement ?? []) {
    if (i.id === id) {
      return {
        category: i.category ?? 'photography_critique_improvement',
        text: i.text,
        photo_ref: i.photo_ref,
      };
    }
  }
  return null;
}

/**
 * Record feedback on a single brief insight.
 *
 * @param {any} db
 * @param {{ insightId: string, verdict: string, source?: string, freeText?: string }} args
 * @returns {Promise<{ ok: boolean, reason?: string, category?: string, eventId?: string }>}
 */
export async function recordInsightFeedback(
  db,
  { insightId, verdict, source = 'cli', freeText = null },
) {
  if (!/^m\d{1,3}$/i.test(insightId)) {
    return { ok: false, reason: 'invalid_insight_id' };
  }
  if (!VERDICTS.has(verdict)) {
    return { ok: false, reason: 'invalid_verdict' };
  }
  const found = await findInsight(db, insightId.toLowerCase());
  if (!found) {
    return { ok: false, reason: 'insight_not_found' };
  }
  const externalId = `insight_feedback__${insightId.toLowerCase()}__${Date.now()}`;
  await db
    .query(
      surql`CREATE events CONTENT {
        source: 'insight_feedback',
        content: ${`[${insightId}] ${verdict}${freeText ? ` — ${freeText}` : ''}`},
        ts: time::now(),
        meta: ${{
          insight_id: insightId.toLowerCase(),
          category: found.category,
          verdict,
          source,
          free_text: freeText,
          brief_event_id: found.briefEventId,
          external_id: externalId,
          ref: found.ref ?? null,
        }}
      }`,
    )
    .collect();

  return { ok: true, category: found.category, eventId: externalId };
}
