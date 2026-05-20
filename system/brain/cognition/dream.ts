import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';

export interface DreamResult {
  predictionsResolved: number;
  brierDeltaSum: number;
  journalGenerated: boolean;
}

/**
 * Nightly consolidation job:
 * - Resolves predictions whose deadlines have passed (marks unverifiable if no resolution method ran)
 * - Computes basic daily metric counts (events, captures, corrections)
 * - Generates a simple journal entry
 */
export async function runDream(
  db: RobinDb,
  _llm: LLMDispatcher | null,
  now: Date = new Date(),
): Promise<DreamResult> {
  const result: DreamResult = { predictionsResolved: 0, brierDeltaSum: 0, journalGenerated: false };

  // 1. Auto-resolve predictions past deadline as 'unverifiable' if not already resolved
  const overdue = db
    .prepare(`
    SELECT id, confidence FROM predictions WHERE outcome IS NULL AND deadline IS NOT NULL AND deadline < ?
  `)
    .all(now.toISOString()) as Array<{ id: number; confidence: number }>;
  const resolveStmt = db.prepare(
    `
    UPDATE predictions SET outcome = ?, resolved_at = ?, brier_delta = NULL WHERE id = ?
  `,
  );
  for (const p of overdue) {
    resolveStmt.run('unverifiable', now.toISOString(), p.id);
    result.predictionsResolved++;
  }

  // 2. Metrics rollup for today
  const today = now.toISOString().slice(0, 10);
  const since = `${today}T00:00:00.000Z`;
  const eventsToday = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ts >= ?`).get(since) as {
      c: number;
    }
  ).c;
  const capturesToday = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured' AND ts >= ?`)
      .get(since) as {
      c: number;
    }
  ).c;
  const correctionsToday = (
    db.prepare(`SELECT COUNT(*) AS c FROM corrections WHERE ts >= ?`).get(since) as {
      c: number;
    }
  ).c;

  const upsertMetric = db.prepare(`
    INSERT INTO metrics_daily (day, metric, value, n)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (day, metric) DO UPDATE SET value=excluded.value, n=excluded.n, computed_at=datetime('now')
  `);
  upsertMetric.run(today, 'events_count', eventsToday, eventsToday);
  upsertMetric.run(today, 'captures_count', capturesToday, capturesToday);
  upsertMetric.run(today, 'corrections_count', correctionsToday, correctionsToday);

  // 3. Compose a minimal journal entry
  const body = [
    `# Robin Journal — ${today}`,
    ``,
    `**Captured:** ${capturesToday} sessions`,
    `**Corrections:** ${correctionsToday}`,
    `**Events:** ${eventsToday}`,
    `**Predictions resolved (overdue → unverifiable):** ${result.predictionsResolved}`,
  ].join('\n');

  db.prepare(`
    INSERT INTO journals (day, body) VALUES (?, ?)
    ON CONFLICT (day) DO UPDATE SET body=excluded.body, generated_at=datetime('now')
  `).run(today, body);
  result.journalGenerated = true;

  return result;
}
