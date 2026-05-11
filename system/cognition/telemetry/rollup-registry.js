// rollup-registry.js — per-cursor entries the aggregator iterates each tick.
//
// Each entry owns:
//   - name          : unique key; matches a runtime:telemetry.cursor.value.<name>
//   - cursorName    : same as name (kept separate for future renaming)
//   - sourceTable   : the raw table to SELECT from
//   - faculty       : the umbrella `faculty` written into telemetry_hourly
//                     (or a hint, when project() emits multiple faculties)
//   - event_kinds   : array of event_kind strings this entry can emit
//   - select(ctx)   : returns { sql, params } for the grouped scan over
//                     [cursor, cutoff). ctx = { cursor, cutoff, cfg }.
//   - project(row)  : maps one SELECT result row to one-or-more
//                     telemetry_hourly row-family entries:
//                     { faculty, event_kind, hour, dimensions, count,
//                       metric_sums, metric_buckets }
//
// Adding a new hot source = one new entry + add its name to
// runtime:telemetry.config.faculties_enabled. No rollup.js edit beyond
// this file.

const DEFAULT_HOT_CADENCE_PREFIXES = ['belief.', 'dream.'];

function intuitionEntry() {
  return {
    name: 'intuition_telemetry',
    cursorName: 'intuition_telemetry',
    sourceTable: 'intuition_telemetry',
    faculty: 'intuition',
    event_kinds: ['recall'],
    select: ({ cursor, cutoff }) => ({
      sql: `SELECT
        time::floor(ts, 1h)              AS hour,
        meta.from                        AS source,
        meta.mmr_path                    AS mmr_path,
        count()                          AS n,
        math::sum(latency_ms)            AS latency_ms_sum,
        math::sum(tokens_injected)       AS tokens_injected_sum,
        math::sum(hits)                  AS hits_sum,
        math::sum(query_chars)           AS query_chars_sum
      FROM intuition_telemetry
      WHERE ts >= $cursor AND ts < $cutoff
      GROUP BY hour, source, mmr_path`,
      params: { cursor, cutoff },
    }),
    project: (r) => [
      {
        faculty: 'intuition',
        event_kind: 'recall',
        hour: r.hour,
        dimensions: { source: r.source ?? null, mmr_path: r.mmr_path ?? null },
        count: r.n ?? 0,
        metric_sums: {
          latency_ms_sum: r.latency_ms_sum ?? 0,
          tokens_injected_sum: r.tokens_injected_sum ?? 0,
          hits_sum: r.hits_sum ?? 0,
          query_chars_sum: r.query_chars_sum ?? 0,
        },
        metric_buckets: {},
      },
    ],
  };
}

function recallLogEvalEntry() {
  return {
    name: 'recall_log_eval',
    cursorName: 'recall_log_eval',
    sourceTable: 'recall_log',
    faculty: 'intuition', // split in project() into intuition.recall_attribution + reinforcement.evaluate
    event_kinds: ['recall_attribution', 'evaluate'],
    select: ({ cursor, cutoff }) => ({
      sql: `SELECT
        time::floor(evaluated_at, 1h)        AS hour,
        outcome                              AS outcome,
        attribution.mode                     AS attribution_mode,
        meta.from                            AS source,
        meta.focus_block_present             AS focus_block_present,
        count()                              AS n,
        math::sum(attribution.used_count)    AS used_count_sum,
        math::sum(attribution.total)         AS total_sum,
        math::sum(attribution.dropped_hits)  AS dropped_hits_sum,
        math::sum(attribution.elapsed_ms)    AS elapsed_ms_sum,
        math::sum(meta.focus_block_tokens)   AS focus_block_tokens_sum
      FROM recall_log
      WHERE evaluated_at IS NOT NONE
        AND evaluated_at >= $cursor
        AND evaluated_at < $cutoff
      GROUP BY hour, outcome, attribution_mode, source, focus_block_present`,
      params: { cursor, cutoff },
    }),
    project: (r) => {
      const out = [];
      if (r.attribution_mode != null) {
        out.push({
          faculty: 'intuition',
          event_kind: 'recall_attribution',
          hour: r.hour,
          dimensions: {
            mode: r.attribution_mode,
            source: r.source ?? null,
            focus_block_present: r.focus_block_present ?? null,
          },
          count: r.n ?? 0,
          metric_sums: {
            used_count_sum: r.used_count_sum ?? 0,
            total_sum: r.total_sum ?? 0,
            dropped_hits_sum: r.dropped_hits_sum ?? 0,
            elapsed_ms_sum: r.elapsed_ms_sum ?? 0,
            focus_block_tokens_sum: r.focus_block_tokens_sum ?? 0,
          },
          metric_buckets: {},
        });
      }
      out.push({
        faculty: 'reinforcement',
        event_kind: 'evaluate',
        hour: r.hour,
        dimensions: { outcome: r.outcome ?? null },
        count: r.n ?? 0,
        metric_sums: {},
        metric_buckets: {},
      });
      return out;
    },
  };
}

function cadenceTelemetryHotEntry() {
  return {
    name: 'cadence_telemetry_hot',
    cursorName: 'cadence_telemetry_hot',
    sourceTable: 'cadence_telemetry',
    faculty: 'belief', // split in project() by step prefix
    event_kinds: ['call', '<dream sub-steps>'],
    select: ({ cursor, cutoff, cfg }) => {
      const prefixes = cfg?.cadence_hot_steps ?? DEFAULT_HOT_CADENCE_PREFIXES;
      const orClauses = prefixes
        .map((_, i) => `string::starts_with(step, $p${i})`)
        .join(' OR ');
      const params = { cursor, cutoff };
      prefixes.forEach((p, i) => {
        params[`p${i}`] = p;
      });
      return {
        sql: `SELECT
          time::floor(ts, 1h)              AS hour,
          step                             AS step,
          success                          AS success,
          count()                          AS n,
          math::sum(duration_ms)           AS latency_ms_sum,
          math::sum(tokens_in)             AS tokens_in_sum,
          math::sum(tokens_out)            AS tokens_out_sum
        FROM cadence_telemetry
        WHERE ts >= $cursor AND ts < $cutoff
          AND (${orClauses})
        GROUP BY hour, step, success`,
        params,
      };
    },
    project: (r) => {
      const step = String(r.step ?? '');
      const dot = step.indexOf('.');
      const family = dot > 0 ? step.slice(0, dot) : step;
      const kind = dot > 0 ? step.slice(dot + 1) : 'unknown';
      return [
        {
          faculty: family,
          event_kind: kind,
          hour: r.hour,
          dimensions: { success: r.success ?? null },
          count: r.n ?? 0,
          metric_sums: {
            latency_ms_sum: r.latency_ms_sum ?? 0,
            tokens_in_sum: r.tokens_in_sum ?? 0,
            tokens_out_sum: r.tokens_out_sum ?? 0,
          },
          metric_buckets: {},
        },
      ];
    },
  };
}

function metaCognitionEntry() {
  return {
    name: 'meta_cognition_telemetry',
    cursorName: 'meta_cognition_telemetry',
    sourceTable: 'meta_cognition_telemetry',
    faculty: 'meta_cognition',
    event_kinds: ['run'],
    select: ({ cursor, cutoff }) => ({
      sql: `SELECT
        time::floor(ts, 1h)              AS hour,
        outcome                          AS outcome,
        count()                          AS n,
        math::sum(tokens_in)             AS tokens_in_sum,
        math::sum(tokens_out)            AS tokens_out_sum,
        math::sum(latency_ms)            AS latency_ms_sum,
        math::sum(actions_proposed)      AS actions_proposed_sum,
        math::sum(actions_accepted)      AS actions_accepted_sum
      FROM meta_cognition_telemetry
      WHERE ts >= $cursor AND ts < $cutoff
      GROUP BY hour, outcome`,
      params: { cursor, cutoff },
    }),
    project: (r) => [
      {
        faculty: 'meta_cognition',
        event_kind: 'run',
        hour: r.hour,
        dimensions: { outcome: r.outcome ?? null },
        count: r.n ?? 0,
        metric_sums: {
          tokens_in_sum: r.tokens_in_sum ?? 0,
          tokens_out_sum: r.tokens_out_sum ?? 0,
          latency_ms_sum: r.latency_ms_sum ?? 0,
          actions_proposed_sum: r.actions_proposed_sum ?? 0,
          actions_accepted_sum: r.actions_accepted_sum ?? 0,
        },
        metric_buckets: {},
      },
    ],
  };
}

// Map registry entry name → set of faculties it can emit. Used by
// getEnabledEntries() to honour the faculties_enabled kill-switch.
const NAME_TO_FACULTIES = {
  intuition_telemetry: ['intuition'],
  recall_log_eval: ['intuition', 'reinforcement'],
  cadence_telemetry_hot: ['belief', 'dream'],
  meta_cognition_telemetry: ['meta_cognition'],
};

export function buildRegistry() {
  return [
    intuitionEntry(),
    recallLogEvalEntry(),
    cadenceTelemetryHotEntry(),
    metaCognitionEntry(),
  ];
}

export function getEnabledEntries(reg, cfg) {
  const enabled = new Set(cfg?.faculties_enabled ?? []);
  return reg.filter((e) =>
    (NAME_TO_FACULTIES[e.name] ?? []).some((f) => enabled.has(f)),
  );
}
