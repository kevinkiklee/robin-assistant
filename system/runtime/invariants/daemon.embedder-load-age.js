// daemon.embedder_load_age
//
// Warn if the synthetic daily embed probe row has not been refreshed in >24h.
// Distinguishes "embedder broken" from "no traffic" (the probe runs daily
// regardless of memory traffic).
//
// Detect-only for 7 days after install. After that, auto-repair (run the
// probe immediately) becomes available via per-invariant config flag.
//
// The probe writer is filed to the cognition-e1 lane (system/data/embed/
// factory.js is e1-owned). Until wired, this invariant will report
// `no_probe_record` — that is the documented detect-only-mode behavior:
// the absence of a probe row is itself a signal that the embedder may be
// unverified.

const STALE_THRESHOLD_MS = 24 * 3600 * 1000;

export default {
  name: 'daemon.embedder_load_age',
  level: 'warn',
  surface: 'runtime',
  phase: 'runtime',
  description:
    'Synthetic embed probe has completed within the last 24h (proves the embedder is alive even under low traffic).',
  detectOnly: true,
  detectOnlyUntilDays: 7,

  remediation: [
    'robin embeddings list  # confirm active profile and dimension',
    'robin embeddings backfill <profile>  # if the active profile is broken',
    'tail -200 user-data/runtime/logs/daemon.log | grep "embed"',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 3_600_000 }, // hourly
    doctor: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const builder = ctx.db.query(
        'SELECT last_success_ts FROM runtime_state WHERE id = "runtime:embed_probe";',
      );
      const rows = await builder.collect();
      const lastTs = rows?.[0]?.last_success_ts;
      if (!lastTs) {
        return {
          ok: false,
          error: 'no_probe_record',
          evidence: { hint: 'probe has never run; awaiting cognition-e1 wiring' },
        };
      }
      const ageMs = Date.now() - new Date(lastTs).getTime();
      if (ageMs > STALE_THRESHOLD_MS) {
        return {
          ok: false,
          error: 'stale_embed_probe',
          evidence: {
            age_ms: ageMs,
            last_success_ts: lastTs,
            threshold_ms: STALE_THRESHOLD_MS,
          },
        };
      }
      return { ok: true, evidence: { age_ms: ageMs, last_success_ts: lastTs } };
    } catch (e) {
      return { ok: false, error: e.message ?? 'probe_check_failed' };
    }
  },

  explain() {
    return [
      '### `daemon.embedder_load_age`',
      '',
      '**Symptom.** Recall returns sparse results even for known-recent topics; daemon log shows embedding failures.',
      '',
      '**Cause.** Embedder loaded successfully at boot but a profile mismatch, dimension mismatch, or NAPI handle drop is silently failing every embed since.',
      '',
      '**Fix.** Run `robin embeddings list` to see the active profile and configured dimension; if mismatched, `robin embeddings activate <correct-profile>` or `robin embeddings backfill <profile>` to repair.',
    ].join('\n');
  },
};
