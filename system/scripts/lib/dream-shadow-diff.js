// Dream parallel-run shadow diff helper.
//
// During the Phase 4c soak window (per spec §5.5.1), dream runs both as a
// subagent (live; writes to memory) and inline (shadow; outputs discarded).
// Each run produces a structured return per dream's schema:
//
//   routed_count: int
//   notable: [string]
//   errors: [string]
//   tier1_touched: [string]
//
// This helper diffs two such results and returns the meaningful differences.
// "Trivial" differences (counter off-by-one, set order) are filtered out;
// the gate is whether a 7-day window of diffs is null/trivial.

export function diffDreamReturns(subagent, inline) {
  const issues = [];

  // routed_count: exact match expected
  if (subagent.routed_count !== inline.routed_count) {
    issues.push({
      field: 'routed_count',
      severity: 'major',
      detail: `subagent=${subagent.routed_count}, inline=${inline.routed_count}`,
    });
  }

  // notable: same set (order-insensitive); content drift = major
  const notableDiff = setDiff(subagent.notable ?? [], inline.notable ?? []);
  if (notableDiff.onlyA.length > 0 || notableDiff.onlyB.length > 0) {
    issues.push({
      field: 'notable',
      severity: notableDiff.onlyA.length + notableDiff.onlyB.length > 1 ? 'major' : 'minor',
      detail: `only-in-subagent: ${JSON.stringify(notableDiff.onlyA)}; only-in-inline: ${JSON.stringify(notableDiff.onlyB)}`,
    });
  }

  // errors: any error in either side is significant
  const errorsA = subagent.errors ?? [];
  const errorsB = inline.errors ?? [];
  if (errorsA.length > 0 || errorsB.length > 0) {
    if (errorsA.length !== errorsB.length || !setsEqual(errorsA, errorsB)) {
      issues.push({
        field: 'errors',
        severity: 'major',
        detail: `subagent: ${JSON.stringify(errorsA)}; inline: ${JSON.stringify(errorsB)}`,
      });
    }
  }

  // tier1_touched: same set
  const t1Diff = setDiff(subagent.tier1_touched ?? [], inline.tier1_touched ?? []);
  if (t1Diff.onlyA.length > 0 || t1Diff.onlyB.length > 0) {
    issues.push({
      field: 'tier1_touched',
      severity: 'major',
      detail: `only-in-subagent: ${JSON.stringify(t1Diff.onlyA)}; only-in-inline: ${JSON.stringify(t1Diff.onlyB)}`,
    });
  }

  return {
    matches: issues.length === 0,
    severity: issues.some((i) => i.severity === 'major') ? 'major'
      : issues.length > 0 ? 'minor' : 'none',
    issues,
  };
}

function setDiff(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: [...setA].filter((x) => !setB.has(x)),
    onlyB: [...setB].filter((x) => !setA.has(x)),
    both: [...setA].filter((x) => setB.has(x)),
  };
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (!setA.has(x)) return false;
  return true;
}

// Aggregate N days of dream-shadow diffs. Returns whether the soak gate
// passes per spec §5.2 row 4c (7 consecutive days with diff == null/trivial).
export function evaluateSoakWindow(dailyDiffs) {
  if (!Array.isArray(dailyDiffs) || dailyDiffs.length < 7) {
    return {
      passes: false,
      reason: `insufficient days (need ≥7, got ${dailyDiffs?.length ?? 0})`,
      majorDays: 0,
      minorDays: 0,
      cleanDays: 0,
    };
  }
  const last7 = dailyDiffs.slice(-7);
  let majorDays = 0;
  let minorDays = 0;
  let cleanDays = 0;
  for (const d of last7) {
    if (d.severity === 'major') majorDays++;
    else if (d.severity === 'minor') minorDays++;
    else cleanDays++;
  }
  const passes = majorDays === 0;  // any major in 7 days = fail
  return {
    passes,
    reason: passes
      ? `7-day soak clean (${cleanDays} clean, ${minorDays} minor, 0 major)`
      : `${majorDays} major-severity day(s) in 7-day window`,
    majorDays,
    minorDays,
    cleanDays,
  };
}
