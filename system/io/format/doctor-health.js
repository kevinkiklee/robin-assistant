// Reshape a flat list of invariant results into realm-grouped JSON for the
// `health()` MCP tool. Agent-facing: no remediation strings (the agent
// renders those itself from the invariant `class`, fetched separately if
// needed). The CLI surface (`robin doctor`) renders remediation inline; the
// MCP surface returns structured data and lets the agent decide what to
// surface.
//
// Input contract (mirrors what the invariants runner emits, normalized by
// the doctor dispatcher):
//   results: [{ name, surface, status: 'ok'|'warn'|'fail', error?, ... }]
//   ts:      ISO timestamp string
//   summary: { ok, warn, fail }
//
// Output contract:
//   {
//     ts,
//     summary,
//     realms: {
//       <realm>: {
//         status: 'ok' | 'warn' | 'fail',   // worst case across realm's checks
//         checks: [{ name, status, error: error|null }]
//       }
//     }
//   }
//
// Status rollup is monotonic: `fail` sticks, `warn` overrides `ok`, `ok` is
// the floor. This matches the CLI render's realm-status logic so the two
// surfaces agree on severity.

export function reshapeForMCP({ results = [], ts, summary } = {}) {
  const realms = {};
  for (const r of results) {
    const realm = r.surface ?? 'other';
    if (!realms[realm]) realms[realm] = { status: 'ok', checks: [] };
    realms[realm].checks.push({
      name: r.name,
      status: r.status,
      error: r.error ?? null,
    });
    if (r.status === 'fail') {
      realms[realm].status = 'fail';
    } else if (r.status === 'warn' && realms[realm].status !== 'fail') {
      realms[realm].status = 'warn';
    }
  }
  return { ts, summary, realms };
}
