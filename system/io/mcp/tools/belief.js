// belief.js — MCP tool: aggregate evidence-backed confidence over recalled
// knowledge memos, apply calibration, recommend assert|soften|unknown.
//
// Spec §1, §2. Composes:
//   1. searchMemos(kind='knowledge', limit=k*overfetch)
//   2. aggregateBelief (relevance + confidence filter + weighted average)
//   3. filterPrivateRefs (direct + transitive)
//   4. readCalibration + calibrateAdjust
//   5. recommendBelief
//   6. cadence_telemetry write (sampled, step='belief.call')
//
// belief.js writes ONLY to `cadence_telemetry` — this is enforced by the
// audit-introspection-readonly invariant in tests/unit.

import { BoundQuery, surql } from 'surrealdb';
import { aggregateBelief } from '../../../cognition/belief/aggregate.js';
import { calibrateAdjust, readCalibration } from '../../../cognition/belief/calibration.js';
import { readBeliefConfig } from '../../../cognition/belief/config.js';
import { inferDomain } from '../../../cognition/belief/domain.js';
import { filterPrivateRefs } from '../../../cognition/belief/privacy.js';
import { recommendBelief } from '../../../cognition/belief/recommend.js';
import { batchStructuralWeights } from '../../../cognition/belief/structural-weights.js';
import * as store from '../../../cognition/memory/store.js';
import { sha256 } from '../../../data/embed/hash.js';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    domain: { type: 'string', minLength: 1, maxLength: 80 },
    k: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
  },
  required: ['query'],
  additionalProperties: false,
});

function snippet(content) {
  if (!content) return '';
  const s = String(content).slice(0, 200);
  const cut = Math.max(s.lastIndexOf('.'), s.lastIndexOf('!'), s.lastIndexOf('?'));
  if (cut > 80) return s.slice(0, cut + 1);
  return s.length === String(content).length ? s : `${s}…`;
}

function shouldLog(query, sample_rate) {
  if (sample_rate >= 1) return true;
  if (sample_rate <= 0) return false;
  const h = parseInt(sha256(String(query ?? '')).slice(0, 8), 16);
  const bucket = h / 0xffffffff;
  return bucket < sample_rate;
}

async function recordTelemetry(db, row) {
  try {
    await db.query(new BoundQuery('CREATE cadence_telemetry CONTENT $row', { row })).collect();
  } catch {
    /* telemetry advisory; never escalate */
  }
}

async function getCatalogFallback(db) {
  try {
    const [rows] = await db
      .query(surql`SELECT name, type FROM entities ORDER BY created_at DESC LIMIT 100`)
      .collect();
    return rows ?? [];
  } catch {
    return [];
  }
}

export function createBeliefTool({ db, embedder, catalog }) {
  return {
    name: 'belief',
    description:
      'Aggregate evidence-backed confidence for a query and recommend assert | soften | unknown.',
    inputSchema: INPUT_SCHEMA,
    async handler(input) {
      const started = Date.now();
      const query = input?.query;
      const k = input?.k ?? 8;
      const meta = {
        k_requested: k,
        k_returned: 0,
        hits_dropped_private: 0,
        hits_dropped_relevance: 0,
        elapsed_ms: 0,
        fallback_path: null,
        domain_inferred: null,
        shadow: true,
      };

      try {
        const cfg = await readBeliefConfig(db);
        meta.shadow = !!cfg.shadow_mode;

        // 1. Domain inference (catalog fallback per R-3 ctx note).
        let cat = catalog;
        if (!Array.isArray(cat)) {
          cat = await getCatalogFallback(db);
        }
        const dom = inferDomain(query, input?.domain, cat ?? [], cfg);
        meta.domain_inferred = dom.telemetry;
        const domain = dom.domain;

        // 2. Recall.
        const k_overfetch = Math.ceil(k * (cfg.belief_overfetch_factor ?? 2));
        const recall = await store.searchMemos(db, embedder, query, {
          kind: 'knowledge',
          limit: k_overfetch,
        });
        const hits = recall?.hits ?? [];

        // 3. Privacy filter on the recall set.
        const allIds = hits.map((h) => h.record?.id ?? h.id).filter(Boolean);
        const { kept_ids, dropped_ids } = await filterPrivateRefs(db, allIds);
        meta.hits_dropped_private = dropped_ids.length;
        if (kept_ids.length === 0 && allIds.length > 0) {
          meta.fallback_path = 'all_private';
          meta.elapsed_ms = Date.now() - started;
          const out = {
            query,
            domain,
            aggregate_confidence: 0,
            calibrated_confidence: 0,
            evidence: [],
            recommendation: 'unknown',
            meta,
          };
          if (cfg.shadow_mode) {
            out.meta.shadow_recommendation_would_have_been = 'unknown';
          }
          if (cfg.telemetry_enabled && shouldLog(query, cfg.telemetry_sample_rate)) {
            await recordTelemetry(db, {
              step: 'belief.call',
              tokens_in: 0,
              tokens_out: 0,
              duration_ms: meta.elapsed_ms,
              success: true,
              meta: {
                sample_rate: cfg.telemetry_sample_rate,
                fallback_path: meta.fallback_path,
              },
            });
          }
          return out;
        }

        const keptSet = new Set(kept_ids.map(String));
        const keptHits = hits.filter((h) => keptSet.has(String(h.record?.id ?? h.id)));

        // 4. Batched structural weights + derived confidence.
        const keptHitIds = keptHits.map((h) => h.record?.id ?? h.id);
        const structuralMap = await batchStructuralWeights(db, keptHitIds);
        const [derivedRows] = await db
          .query(
            new BoundQuery(
              `SELECT id, content, decay_anchor, derived_at,
                      fn::derived_confidence(id) AS derived
               FROM memos WHERE id IN $ids`,
              { ids: keptHitIds },
            ),
          )
          .collect();
        const derivedById = new Map();
        const memoById = new Map();
        for (const r of derivedRows ?? []) {
          derivedById.set(String(r.id), Number(r.derived ?? 0));
          memoById.set(String(r.id), r);
        }

        // 5. Aggregate.
        const shaped = keptHits.map((h) => {
          const idStr = String(h.record?.id ?? h.id);
          const sm = structuralMap.get(idStr) ?? { structural: 0 };
          const fallbackConf = h.record?.confidence ?? h.confidence ?? 0.5;
          return {
            id: h.record?.id ?? h.id,
            dist: h.distance ?? 0,
            structural: sm.structural,
            derived: derivedById.get(idStr) ?? fallbackConf,
          };
        });
        const agg = aggregateBelief(shaped, cfg);
        meta.hits_dropped_relevance = agg.hits_dropped_relevance;
        meta.k_returned = agg.k_returned;
        meta.fallback_path = agg.fallback_path;

        // 6. Calibration.
        const cal = await readCalibration(db, domain, cfg);
        const calibrated = calibrateAdjust(agg.aggregate, cal, cfg);

        // 7. Recommendation.
        const rawRecommendation = recommendBelief(calibrated, domain, agg.k_returned, cfg);

        // 8. Build evidence (top k by weight).
        const evidence = [];
        for (let i = 0; i < agg.kept_ids.length && evidence.length < k; i++) {
          const id = agg.kept_ids[i];
          const m = memoById.get(id);
          const lastObs =
            m?.decay_anchor && m?.derived_at && new Date(m.decay_anchor) > new Date(m.derived_at)
              ? m.decay_anchor
              : (m?.derived_at ?? null);
          evidence.push({
            memo_id: id,
            content_snippet: snippet(m?.content ?? ''),
            derived_confidence: derivedById.get(id) ?? 0,
            last_observed: lastObs,
            weight: agg.weights[i] ?? 0,
          });
        }

        meta.elapsed_ms = Date.now() - started;
        const result = {
          query,
          domain,
          aggregate_confidence: agg.aggregate,
          calibrated_confidence: calibrated,
          evidence,
          recommendation: rawRecommendation,
          meta,
        };
        if (cal) result.calibration = cal;

        if (cfg.shadow_mode) {
          result.meta.shadow_recommendation_would_have_been = rawRecommendation;
          result.recommendation = 'unknown';
        }

        if (cfg.telemetry_enabled && shouldLog(query, cfg.telemetry_sample_rate)) {
          await recordTelemetry(db, {
            step: 'belief.call',
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: meta.elapsed_ms,
            success: true,
            meta: {
              sample_rate: cfg.telemetry_sample_rate,
              recommendation: result.recommendation,
              shadow_would_have_been: result.meta.shadow_recommendation_would_have_been ?? null,
              fallback_path: meta.fallback_path,
              k_returned: agg.k_returned,
              hits_dropped_private: meta.hits_dropped_private,
              calibration_source: cal?.source ?? null,
            },
          });
        }
        return result;
      } catch (err) {
        meta.elapsed_ms = Date.now() - started;
        meta.fallback_path = 'error';
        try {
          await recordTelemetry(db, {
            step: 'belief.call',
            tokens_in: 0,
            tokens_out: 0,
            duration_ms: meta.elapsed_ms,
            success: false,
            error: String(err?.message ?? err),
            meta: { sample_rate: 1 },
          });
        } catch {
          /* ignore */
        }
        return {
          error: 'belief_internal',
          query: input?.query ?? null,
          domain: input?.domain ?? null,
          aggregate_confidence: 0,
          calibrated_confidence: 0,
          evidence: [],
          recommendation: 'unknown',
          meta,
        };
      }
    },
  };
}
