import type { Invariant, InvariantCheckResult, InvariantReport } from './types.ts';

export interface RunInvariantsOpts {
  fix?: boolean;
  /** Called for a failing, repairable invariant right before `repair()` would
   *  run. Return `false` to skip the repair() call for this invariant (the
   *  invariant is still re-checked afterward, exactly as if repair had run).
   *  Omitted → always proceed, same as today. Lets a caller (doctor.run)
   *  route the repair decision through its own once-per-incident guard and
   *  circuit breaker instead of always repairing. */
  beforeRepair?: (inv: Invariant) => boolean;
  /** Called when `repair()` throws, in addition to the report's own
   *  `repair_error` field. Lets a caller notch its own bookkeeping (e.g. the
   *  repair circuit breaker) without re-deriving the error from the report. */
  onRepairError?: (inv: Invariant, err: unknown) => void;
}

/**
 * Run every invariant's check. With `opts.fix`, any FAILING check that declares a
 * `repair()` is auto-repaired and then RE-CHECKED, so the reported `ok` reflects
 * the post-repair truth — not the repair's optimism. Backward-compatible: callers
 * that pass no opts (health-monitor, plain `robin doctor`) get pure checks, and
 * callers that pass `fix` alone (no hooks) get byte-identical behavior to before
 * `beforeRepair`/`onRepairError` existed — `beforeRepair` defaults to "proceed".
 */
export async function runInvariants(
  invariants: Invariant[],
  opts: RunInvariantsOpts = {},
): Promise<InvariantReport[]> {
  const results: InvariantReport[] = [];
  for (const inv of invariants) {
    const start = performance.now();
    let r = await safeCheck(inv);
    let repaired: boolean | undefined;
    let repair_error: string | undefined;
    if (!r.ok && opts.fix && inv.repair) {
      const proceed = opts.beforeRepair ? opts.beforeRepair(inv) : true;
      if (proceed) {
        repaired = true;
        try {
          await inv.repair();
        } catch (err) {
          repair_error = err instanceof Error ? err.message : String(err);
          opts.onRepairError?.(inv, err);
        }
      }
      r = await safeCheck(inv); // re-check: status must reflect reality (or reaffirm the skip)
    }
    results.push({
      name: inv.name,
      severity: inv.severity,
      ok: r.ok,
      message: r.message,
      remediation: r.remediation,
      duration_ms: Math.round(performance.now() - start),
      ...(repaired ? { repaired } : {}),
      ...(repair_error ? { repair_error } : {}),
    });
  }
  return results;
}

/** Run one check, converting a thrown error into a failing result (preserved message). */
async function safeCheck(inv: Invariant): Promise<InvariantCheckResult> {
  try {
    return await inv.check();
  } catch (err) {
    return {
      ok: false,
      message: `check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
