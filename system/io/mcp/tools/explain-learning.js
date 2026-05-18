import { BoundQuery } from 'surrealdb';
import { wrapUntrusted } from '../../../cognition/discretion/wrap-untrusted.js';
import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

const MAX_LINEAGE_DEPTH = 4;

/**
 * Fetch a memo by ID string. Returns null if not found. Throws on DB error
 * so the MCP caller distinguishes "no such id" (returns {ok:false,
 * reason:'not_found'}) from "DB query failed" (propagates as an MCP error).
 */
async function fetchMemo(db, id) {
  if (!id) return null;
  const ref = String(id).startsWith('memos:') ? String(id) : `memos:${String(id)}`;
  const [rows] = await db.query(`SELECT * FROM ${ref}`).collect();
  return (Array.isArray(rows) ? rows[0] : rows) ?? null;
}

/**
 * Fetch a rule by ID string. Returns null if not found. Throws on DB error
 * (see fetchMemo for rationale).
 */
async function fetchRule(db, id) {
  if (!id) return null;
  const ref = String(id).startsWith('rules:') ? String(id) : `rules:${String(id)}`;
  const [rows] = await db.query(`SELECT * FROM ${ref}`).collect();
  return (Array.isArray(rows) ? rows[0] : rows) ?? null;
}

/**
 * Fetch a prediction memo. Returns null if not found. Throws on DB error
 * (see fetchMemo for rationale).
 * Predictions are stored as memos with kind='prediction'.
 */
async function fetchPrediction(db, id) {
  if (!id) return null;
  const ref = String(id).startsWith('memos:') ? String(id) : `memos:${String(id)}`;
  const [rows] = await db.query(`SELECT * FROM ${ref} WHERE kind = 'prediction'`).collect();
  return (Array.isArray(rows) ? rows[0] : rows) ?? null;
}

/**
 * Fetch source event for a task_outcome memo. Source-event hydration is
 * best-effort: a missing/broken source link should not fail the parent
 * explainTaskOutcome call, so we degrade to null rather than throwing.
 */
async function fetchSourceEvent(db, eventId) {
  if (!eventId) return null;
  const ref = String(eventId).startsWith('events:') ? String(eventId) : `events:${String(eventId)}`;
  try {
    const [rows] = await db
      .query(`SELECT id, source, content, ts, meta, trust FROM ${ref}`)
      .collect();
    const row = (Array.isArray(rows) ? rows[0] : rows) ?? null;
    if (!row) return null;
    const rawExcerpt = (row.content ?? '').slice(0, 200);
    // Event content may originate from external sources (integrations); wrap if untrusted.
    const trust = row.trust ?? 'untrusted';
    return {
      id: String(row.id),
      source: row.source,
      content_excerpt:
        trust === 'trusted'
          ? rawExcerpt
          : wrapUntrusted(rawExcerpt, { source: row.source, eventId: String(row.id), trust }),
      ts: row.ts,
    };
  } catch {
    // Source-event lineage is informational; tolerate query failure.
    return null;
  }
}

/**
 * Explain a playbook memo — delegates to explain-playbook logic inline.
 */
async function explainPlaybook(db, playbook) {
  const meta = playbook.meta ?? {};
  const outcomeIds = meta.evidence_outcomes ?? [];

  // Fetch source outcomes (capped at MAX_LINEAGE_DEPTH)
  const truncatedIds = outcomeIds.slice(0, MAX_LINEAGE_DEPTH);
  const truncated = outcomeIds.length > MAX_LINEAGE_DEPTH;
  const outcomes = [];
  for (const oid of truncatedIds) {
    const row = await fetchMemo(db, oid);
    if (row) {
      outcomes.push({
        id: String(row.id),
        kind: row.kind,
        content_excerpt: (row.content ?? '').slice(0, 200),
        meta: {
          task_type: row.meta?.task_type ?? null,
          task_id: row.meta?.task_id ?? null,
          score: row.meta?.score ?? null,
          signals: row.meta?.signals ?? {},
        },
      });
    }
  }

  // Prior version
  const priorId = meta.supersedes;
  let priorVersion = null;
  if (priorId) {
    const prior = await fetchMemo(db, priorId);
    if (prior) {
      priorVersion = {
        id: String(prior.id),
        version: prior.meta?.version ?? null,
        derived_at: prior.derived_at ?? null,
        active: prior.meta?.active ?? null,
        content_excerpt: (prior.content ?? '').slice(0, 500),
      };
    }
  }

  // Cited rules
  const ruleIds = meta.related_rules ?? [];
  const citedRules = [];
  for (const rid of ruleIds.slice(0, 20)) {
    const rule = await fetchRule(db, rid);
    if (rule) {
      citedRules.push({
        id: String(rule.id),
        content: (rule.content ?? '').slice(0, 300),
        active: rule.active ?? null,
        kind: rule.kind ?? null,
      });
    }
  }

  return {
    kind: 'playbook',
    playbook: {
      id: String(playbook.id),
      content: playbook.content,
      derived_by: playbook.derived_by,
      derived_at: playbook.derived_at,
      meta: {
        task_type: meta.task_type ?? null,
        version: meta.version ?? null,
        active: meta.active ?? null,
        cold_start: meta.cold_start ?? null,
        signal_count: meta.signal_count ?? null,
        last_synthesized_at: meta.last_synthesized_at ?? null,
        synthesis_step_version: meta.synthesis_step_version ?? null,
      },
    },
    prior_version: priorVersion,
    source_outcomes: { items: outcomes, truncated, total: outcomeIds.length },
    cited_rules: citedRules,
  };
}

/**
 * Explain a task_outcome memo — returns outcome details + lineage to source event.
 */
async function explainTaskOutcome(db, outcome) {
  const meta = outcome.meta ?? {};
  const sourceEvent = await fetchSourceEvent(db, meta.source_event);

  return {
    kind: 'task_outcome',
    outcome: {
      id: String(outcome.id),
      content: outcome.content,
      derived_at: outcome.derived_at,
      meta: {
        task_type: meta.task_type ?? null,
        task_id: meta.task_id ?? null,
        signals: meta.signals ?? {},
        score: meta.score ?? null,
        playbook_used: meta.playbook_used ?? null,
        playbook_version: meta.playbook_version ?? null,
      },
    },
    source_event: sourceEvent,
  };
}

/**
 * Explain a comm_style_snapshot memo.
 */
function explainCommStyleSnapshot(snapshot) {
  const meta = snapshot.meta ?? {};
  return {
    kind: 'comm_style_snapshot',
    snapshot: {
      id: String(snapshot.id),
      content: snapshot.content,
      derived_at: snapshot.derived_at,
      meta: {
        context: meta.context ?? null,
        content_hash: meta.content_hash ?? null,
        last_synthesized_at: meta.last_synthesized_at ?? null,
        volatile: meta.volatile ?? false,
      },
    },
  };
}

/**
 * Explain a confidence_band memo — return bucket math + sample predictions.
 */
async function explainConfidenceBand(db, band) {
  const meta = band.meta ?? {};
  const statementKind = meta.statement_kind;
  const bucket = meta.bucket;

  // Fetch sample predictions in this statement_kind and bucket range
  let samplePredictions = [];
  if (statementKind && bucket !== null && bucket !== undefined) {
    const bucketLow = bucket;
    const bucketHigh = bucketLow + 0.1;
    try {
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT id, content, confidence, meta
             FROM memos
             WHERE kind = 'prediction'
               AND meta.statement_kind = $sk
               AND confidence >= $lo
               AND confidence < $hi
             LIMIT ${MAX_LINEAGE_DEPTH}`,
            { sk: statementKind, lo: bucketLow, hi: bucketHigh },
          ),
        )
        .collect();
      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
      samplePredictions = list.map((r) => ({
        id: String(r.id),
        statement_excerpt: (r.content ?? '').slice(0, 150),
        confidence: r.confidence,
        resolved: Boolean(r.meta?.resolved_at),
        correct: r.meta?.correct ?? null,
      }));
    } catch {
      // Non-critical; proceed without samples.
    }
  }

  const n = meta.n ?? 0;
  const correct = meta.correct ?? 0;
  const accuracyLaplace = n > 0 ? (correct + 1) / (n + 2) : null;
  const rawAccuracy = n > 0 ? correct / n : null;

  return {
    kind: 'confidence_band',
    band: {
      id: String(band.id),
      content: band.content,
      meta: {
        statement_kind: statementKind ?? null,
        bucket: bucket ?? null,
        n,
        correct,
        accuracy_laplace: accuracyLaplace,
        raw_accuracy: rawAccuracy,
        last_recomputed_at: meta.last_recomputed_at ?? null,
      },
    },
    bucket_math: {
      formula: '(correct + 1) / (n + 2)',
      laplace_accuracy: accuracyLaplace,
      raw_accuracy: rawAccuracy,
      n,
    },
    sample_predictions: samplePredictions,
  };
}

/**
 * Explain a rule — return rule content + source_candidate + cited_by playbooks.
 */
async function explainRule(db, rule) {
  const sourceCandidateId = rule.source_candidate ? String(rule.source_candidate) : null;
  let sourceCandidate = null;
  if (sourceCandidateId) {
    const ref = sourceCandidateId.startsWith('rule_candidates:')
      ? sourceCandidateId
      : `rule_candidates:${sourceCandidateId}`;
    try {
      const [rows] = await db
        .query(`SELECT id, content, kind, status, payload FROM ${ref}`)
        .collect();
      const row = (Array.isArray(rows) ? rows[0] : rows) ?? null;
      if (row) {
        sourceCandidate = {
          id: String(row.id),
          content: row.content ?? null,
          kind: row.kind ?? null,
          status: row.status ?? null,
          synthesis_body: row.payload?.synthesis_body ?? null,
        };
      }
    } catch {
      // Candidate may have been GC'd.
    }
  }

  // Find playbooks that cite this rule (via related_rules field)
  let citedByPlaybooks = [];
  try {
    const [rows] = await db
      .query(
        new BoundQuery(
          `SELECT id, meta.task_type AS task_type, meta.version AS version, meta.active AS active
           FROM memos
           WHERE kind = 'playbook'
             AND meta.related_rules CONTAINS $rid
           LIMIT ${MAX_LINEAGE_DEPTH}`,
          { rid: String(rule.id) },
        ),
      )
      .collect();
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    citedByPlaybooks = list.map((r) => ({
      id: String(r.id),
      task_type: r.task_type ?? null,
      version: r.version ?? null,
      active: r.active ?? null,
    }));
  } catch {
    // Non-critical.
  }

  return {
    kind: 'rule',
    rule: {
      id: String(rule.id),
      content: rule.content,
      kind: rule.kind,
      active: rule.active,
      priority: rule.priority ?? null,
      created_at: rule.created_at,
    },
    source_candidate: sourceCandidate,
    cited_by_playbooks: citedByPlaybooks,
  };
}

/**
 * Explain a prediction memo — return prediction state + linked confidence_band updates.
 */
async function explainPrediction(db, prediction) {
  const meta = prediction.meta ?? {};
  const statementKind = meta.statement_kind;
  const confidence = prediction.confidence;

  // Find the confidence_band that covers this prediction's bucket
  let confidenceBand = null;
  if (statementKind && typeof confidence === 'number') {
    const bucket = Math.floor(confidence * 10) / 10; // round down to 0.1 bucket
    try {
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT id, meta FROM memos
             WHERE kind = 'confidence_band'
               AND meta.statement_kind = $sk
               AND meta.bucket = $bk
             LIMIT 1`,
            { sk: statementKind, bk: bucket },
          ),
        )
        .collect();
      const row = (Array.isArray(rows) ? rows[0] : rows) ?? null;
      if (row) {
        confidenceBand = {
          id: String(row.id),
          statement_kind: row.meta?.statement_kind ?? null,
          bucket: row.meta?.bucket ?? null,
          n: row.meta?.n ?? 0,
          accuracy_laplace: row.meta?.accuracy_laplace ?? null,
        };
      }
    } catch {
      // Non-critical.
    }
  }

  return {
    kind: 'prediction',
    prediction: {
      id: String(prediction.id),
      statement: prediction.content,
      statement_kind: statementKind ?? null,
      confidence,
      predicted_at: prediction.derived_at,
      expected_resolution_at: meta.expected_resolution_at ?? null,
      resolved_at: meta.resolved_at ?? null,
      correct: meta.correct ?? null,
      actual_outcome: meta.actual_outcome ?? null,
    },
    confidence_band: confidenceBand,
  };
}

export function createExplainLearningTool({ db }) {
  return {
    name: 'explain_learning',
    description:
      'Explain the provenance of a specific learned artifact — a task_outcome memo, a rule from a rule candidate, or a resolved prediction. Exactly one of memo_id, rule_id, or prediction_id must be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', minLength: 1 },
        rule_id: { type: 'string', minLength: 1 },
        prediction_id: { type: 'string', minLength: 1 },
      },
    },
    handler: async (args) => {
      // Validate exactly one of the three identifiers is present
      const provided = [args.memo_id, args.rule_id, args.prediction_id].filter(
        (v) => v !== undefined && v !== null,
      );
      if (provided.length !== 1) {
        return { ok: false, reason: 'exactly_one_id_required' };
      }

      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      // ── rule_id path ───────────────────────────────────────────────────────
      if (args.rule_id) {
        const rule = await fetchRule(db, args.rule_id);
        if (!rule) return { ok: false, reason: 'not_found' };
        const result = await explainRule(db, rule);
        return { ok: true, ...result };
      }

      // ── prediction_id path ─────────────────────────────────────────────────
      if (args.prediction_id) {
        const prediction = await fetchPrediction(db, args.prediction_id);
        if (!prediction) return { ok: false, reason: 'not_found' };
        const result = await explainPrediction(db, prediction);
        return { ok: true, ...result };
      }

      // ── memo_id path — dispatch on kind ────────────────────────────────────
      const memo = await fetchMemo(db, args.memo_id);
      if (!memo) return { ok: false, reason: 'not_found' };

      switch (memo.kind) {
        case 'playbook': {
          const result = await explainPlaybook(db, memo);
          return { ok: true, ...result };
        }
        case 'comm_style_snapshot': {
          const result = explainCommStyleSnapshot(memo);
          return { ok: true, ...result };
        }
        case 'task_outcome': {
          const result = await explainTaskOutcome(db, memo);
          return { ok: true, ...result };
        }
        case 'confidence_band': {
          const result = await explainConfidenceBand(db, memo);
          return { ok: true, ...result };
        }
        case 'prediction': {
          // prediction_id is the canonical path, but memo_id also works.
          const result = await explainPrediction(db, memo);
          return { ok: true, ...result };
        }
        default:
          return {
            ok: true,
            kind: memo.kind,
            memo: {
              id: String(memo.id),
              kind: memo.kind,
              content_excerpt: (memo.content ?? '').slice(0, 300),
              derived_by: memo.derived_by,
              derived_at: memo.derived_at,
              meta: memo.meta ?? {},
            },
          };
      }
    },
  };
}
