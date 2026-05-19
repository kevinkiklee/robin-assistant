import type { Invariant, InvariantReport } from './types.ts';

export async function runInvariants(invariants: Invariant[]): Promise<InvariantReport[]> {
  const results: InvariantReport[] = [];
  for (const inv of invariants) {
    const start = performance.now();
    try {
      const r = await inv.check();
      results.push({
        name: inv.name,
        severity: inv.severity,
        ok: r.ok,
        message: r.message,
        remediation: r.remediation,
        duration_ms: Math.round(performance.now() - start),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: inv.name,
        severity: inv.severity,
        ok: false,
        message: `check threw: ${message}`,
        duration_ms: Math.round(performance.now() - start),
      });
    }
  }
  return results;
}
