import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function lintCmd(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;

  let limit;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') limit = Number.parseInt(argv[++i], 10);
  }

  const result = await request('/internal/knowledge/lint', limit ? { limit } : {});
  if (!result?.ok) {
    err(`lint failed: ${result?.reason ?? 'unknown'}`);
    process.exitCode = 1;
    return;
  }
  out(`lint: ${result.returned}/${result.total} issues`);
  for (const i of result.issues ?? []) {
    out(`  [${i.severity}] ${i.kind} ${i.ref} — ${i.message}`);
  }
}
