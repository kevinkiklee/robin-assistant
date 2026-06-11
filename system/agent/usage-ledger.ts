import type { RobinDb } from '../brain/memory/db.ts';

export interface UsageRecord {
  surface: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  status?: string;
  subtype?: string;
  label?: string;
}

export interface OutcomeRecord {
  outcome: string;
  impact?: string;
  structuredJson?: string;
  verified?: string;
}

export interface SurfaceTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  runs: number;
}

/** UTC calendar day (YYYY-MM-DD) for `ts LIKE <day>%` filtering. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Persistent ledger over the `agent_usage` table (migration 011). Every agentic
 * SDK run records one row; per-surface daily caps and health surfacing read it back.
 */
export class UsageLedger {
  constructor(
    private readonly db: RobinDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Insert one run row and return the auto-assigned row id.
   * Callers that don't need the id can safely ignore the return value.
   */
  record(r: UsageRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO agent_usage
           (ts, surface, label, input_tokens, output_tokens, cost_usd, turns, status, subtype)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        r.surface,
        r.label ?? null,
        r.inputTokens,
        r.outputTokens,
        r.costUsd,
        r.turns,
        r.status ?? null,
        r.subtype ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Stamp Phase-B outcome columns onto a previously recorded run row. */
  recordOutcome(id: number, o: OutcomeRecord): void {
    this.db
      .prepare(
        `UPDATE agent_usage SET outcome=?, impact=?, structured_json=?, verified=? WHERE id=?`,
      )
      .run(o.outcome, o.impact ?? null, o.structuredJson ?? null, o.verified ?? null, id);
  }

  /** Total USD spent on a surface during the current UTC day. */
  dailyTotalUsd(surface: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
           FROM agent_usage
          WHERE surface = ? AND ts LIKE ?`,
      )
      .get(surface, `${utcDay(this.now())}%`) as { total: number };
    return row.total;
  }

  /** True once the surface's daily spend reaches (>=) the cap. */
  overCap(surface: string, capUsd: number): boolean {
    return this.dailyTotalUsd(surface) >= capUsd;
  }

  /** Per-surface rollup for the current UTC day, for health/metrics surfacing. */
  todayBySurface(): Record<string, SurfaceTotals> {
    const rows = this.db
      .prepare(
        `SELECT surface,
                COALESCE(SUM(cost_usd), 0) AS costUsd,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(turns), 0) AS turns,
                COUNT(*) AS runs
           FROM agent_usage
          WHERE ts LIKE ?
          GROUP BY surface`,
      )
      .all(`${utcDay(this.now())}%`) as Array<{ surface: string } & SurfaceTotals>;
    const out: Record<string, SurfaceTotals> = {};
    for (const row of rows) {
      const { surface, ...totals } = row;
      out[surface] = totals;
    }
    return out;
  }
}
