import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/**
 * Default ceiling on session.captured events per rolling 24h. Human + known
 * automated-loop baseline is 15–80/day; the 2026-06-12 self-capture feedback
 * loop (Robin capturing its own SDK calls) ran at 840–6,344/day and silently
 * accumulated 24,586 junk sessions over ~3 weeks before it was caught. 200
 * keeps comfortable headroom over busy real days while firing within hours of
 * any new automated source leaking into capture.
 */
const DEFAULT_CAPTURE_VOLUME_THRESHOLD = 200;

/**
 * Flags an abnormal session-capture rate. Capture noise is silent by design —
 * each junk session is individually valid-looking, gets embedded, queued for
 * the biographer, and threaded — so the only cheap global tell is volume. A
 * firing alert means some automated source (an SDK child without the
 * ROBIN_INTERNAL_SDK guard, a runaway claude loop, a new cognition prompt
 * missing from the robin_cognition_echo rule) is being ingested as sessions.
 */
export function captureVolumeSaneInvariant(
  db: RobinDb,
  opts: { threshold?: number } = {},
): Invariant {
  const threshold = opts.threshold ?? DEFAULT_CAPTURE_VOLUME_THRESHOLD;
  return {
    name: 'capture.volume_sane',
    severity: 'warning',
    symptom: 'Session captures in the last 24h exceed the sane-volume ceiling.',
    cause:
      'An automated source is being captured as user sessions: an SDK subprocess missing the ROBIN_INTERNAL_SDK hook guard, a new Robin cognition prompt not covered by the robin_cognition_echo skip rule, or a runaway external claude loop.',
    fix: 'Sample recent session.captured bodies for repeated machine-generated shapes; extend the capture skip-rules or hook guard, then purge the junk family (see prune-noise idiom).',
    check: () => {
      try {
        // events.ts is ISO-with-T; compare against an ISO-format cutoff (a
        // space-format datetime('now') cutoff over-counts same-date rows —
        // the T-vs-space lexicographic trap).
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM events
              WHERE kind = 'session.captured'
                AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`,
          )
          .get() as { n: number };
        if (row.n <= threshold) return { ok: true };
        return {
          ok: false,
          message: `${row.n} sessions captured in 24h (ceiling ${threshold}) — an automated source is likely leaking into capture`,
          remediation:
            'Inspect recent session.captured bodies for machine-generated families; fix the leak (hook guard / echo rule), then purge',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
