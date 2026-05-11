import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function auditCmd(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;

  let pair_count;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pairs') pair_count = Number.parseInt(argv[++i], 10);
  }

  const result = await request('/internal/knowledge/audit', pair_count ? { pair_count } : {});
  if (!result?.ok) {
    err(`audit failed: ${result?.reason ?? 'unknown'}`);
    process.exitCode = 1;
    return;
  }
  out(`audit: ${result.contradictions.length}/${result.pairs_checked} pairs flagged`);
  for (const c of result.contradictions ?? []) {
    out(`  ${c.a_id} vs ${c.b_id}: ${c.summary}`);
  }
}
