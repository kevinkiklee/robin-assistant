import type { RobinDb } from '../memory/db.ts';

/**
 * Prediction creation rules (design 2026-08-10 §4): never predict against a
 * stream that isn't flowing (the Whoop-outage predictions were doomed at birth),
 * and cap nightly-agent runs at 2 predictions — fewer, decision-relevant
 * predictions beat daily micro-calls. The cap is per MCP-server process; agent
 * runs spawn their own stdio servers (ROBIN_AGENT_RUN=1 via mcp-servers.ts), so
 * process lifetime == run lifetime. Interactive sessions are uncapped.
 */
const FRESHNESS_WINDOW_DAYS = 14;
const AGENT_RUN_PREDICTION_CAP = 2;
const MS_PER_DAY = 86_400_000;

let processInsertCount = 0;

export type PredictionGateResult = { ok: true } | { ok: false; reason: string };

export function checkPredictionCreation(
  db: RobinDb,
  input: { sourceStream?: string | null; now?: Date; isAgentRun?: boolean },
): PredictionGateResult {
  const isAgentRun = input.isAgentRun ?? process.env.ROBIN_AGENT_RUN === '1';
  if (isAgentRun && processInsertCount >= AGENT_RUN_PREDICTION_CAP) {
    return {
      ok: false,
      reason: `per-run prediction cap (${AGENT_RUN_PREDICTION_CAP}) reached — make fewer, decision-relevant predictions`,
    };
  }
  const stream = input.sourceStream?.trim();
  if (stream) {
    const source = stream.split('.')[0];
    const now = input.now ?? new Date();
    const row = db.prepare(`SELECT MAX(ts) AS latest FROM events WHERE source = ?`).get(source) as {
      latest: string | null;
    };
    if (!row.latest) {
      return {
        ok: false,
        reason: `stream '${source}' has no events — never predict against a dead stream`,
      };
    }
    const ageMs = now.getTime() - Date.parse(row.latest);
    if (Number.isNaN(ageMs) || ageMs > FRESHNESS_WINDOW_DAYS * MS_PER_DAY) {
      return {
        ok: false,
        reason: `stream '${source}' last flowed ${row.latest} (>${FRESHNESS_WINDOW_DAYS}d) — never predict against a stale stream`,
      };
    }
  }
  return { ok: true };
}

/** Record a successful prediction insert (drives the per-run cap). */
export function notePredictionInserted(): void {
  processInsertCount += 1;
}

/** Test-only: reset the per-process counter between cases. */
export function __resetPredictionGate(): void {
  processInsertCount = 0;
}
