// Repair-policy decisions.
//
// decideRepair(invariant, entry) → 'auto' | 'manual' | 'skip'
//   - level 'info'    → 'auto'
//   - level 'warn'    → 'auto' while last 3 repairs succeeded; 'manual' otherwise
//   - level 'critical'→ 'auto' on consecutive_failures of 1 or 2; 'manual' at 3+

function recentRepairsSucceeded(entry, n = 3) {
  if (!entry.last_repair_at || entry.last_repair_outcome === 'failed') return false;
  // Without a richer ledger we approximate: if there have been no failures
  // (consecutive_failures==0 after the latest pass) and the last repair was
  // 'succeeded', recent repairs are clean.
  return entry.last_repair_outcome === 'succeeded' && entry.consecutive_failures < n;
}

export function decideRepair(invariant, entry) {
  if (invariant.level === 'info') return 'auto';
  if (invariant.level === 'warn') {
    return recentRepairsSucceeded(entry) || !entry.last_repair_at ? 'auto' : 'manual';
  }
  // critical
  if (entry.consecutive_failures >= 3) return 'manual';
  return 'auto';
}

/**
 * Returns the set of invariants that should be reflected in HEALTH_ALERT.md
 * given current state: any invariant whose latest decision is 'manual' AND
 * whose latest check failed.
 */
export function manualAlertSet(invariants, state) {
  const alerts = [];
  for (const inv of invariants) {
    const entry = state.invariants[inv.name];
    if (!entry?.last_result_summary || entry.last_result_summary.ok) continue;
    if (decideRepair(inv, entry) === 'manual') alerts.push(inv);
  }
  return alerts;
}
