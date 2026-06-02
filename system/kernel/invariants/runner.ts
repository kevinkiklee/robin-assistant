import type { Invariant, InvariantCheckResult, InvariantReport } from './types.ts';

/**
 * Run every invariant's check. With `opts.fix`, any FAILING check that declares a
 * `repair()` is auto-repaired and then RE-CHECKED, so the reported `ok` reflects
 * the post-repair truth — not the repair's optimism. Backward-compatible: callers
 * that pass no opts (health-monitor, plain `robin doctor`) get pure checks.
 */
export async function runInvariants(
  invariants: Invariant[],
  opts: { fix?: boolean } = {},
): Promise<InvariantReport[]> {
  const results: InvariantReport[] = [];
  for (const inv of invariants) {
    const start = performance.now();
    let r = await safeCheck(inv);
    let repaired: boolean | undefined;
    let repair_error: string | undefined;
    if (!r.ok && opts.fix && inv.repair) {
      repaired = true;
      try {
        await inv.repair();
      } catch (err) {
        repair_error = err instanceof Error ? err.message : String(err);
      }
      r = await safeCheck(inv); // re-check: status must reflect reality
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
