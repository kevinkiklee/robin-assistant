// src/cli/commands/jobs-run.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function jobsRun(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const name = argv[0];
  if (!name) {
    err('usage: robin jobs run <name> [--force]');
    process.exitCode = 1;
    return;
  }
  const force = argv.includes('--force');
  const result = await request('/internal/jobs/run', { name, force });
  if (result?.ok) {
    out(`ok${result.last_error ? ` (warn: ${result.last_error})` : ''}`);
  } else {
    err(
      `run failed: reason=${result?.reason ?? 'unknown'}${result?.last_error ? ` (${result.last_error})` : ''}`,
    );
    process.exitCode = 1;
  }
}
