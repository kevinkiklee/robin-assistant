import type { RobinDb } from '../memory/db.ts';

export interface CorrectionExample {
  what: string;
  correction: string;
  context: string | null;
}

/**
 * Return the most recent N corrections, optionally filtered by a SQL LIKE pattern over the `what` field.
 * Used as a thin few-shot retrieval helper for layer 3 self-learning.
 */
export function relevantCorrections(
  db: RobinDb,
  opts: { topic?: string; limit?: number } = {},
): CorrectionExample[] {
  const limit = opts.limit ?? 5;
  if (opts.topic) {
    return db
      .prepare(`
      SELECT what, correction, context FROM corrections
       WHERE what LIKE ? OR correction LIKE ? OR (context IS NOT NULL AND context LIKE ?)
       ORDER BY ts DESC LIMIT ?
    `)
      .all(`%${opts.topic}%`, `%${opts.topic}%`, `%${opts.topic}%`, limit) as CorrectionExample[];
  }
  return db
    .prepare(`
    SELECT what, correction, context FROM corrections ORDER BY ts DESC LIMIT ?
  `)
    .all(limit) as CorrectionExample[];
}
