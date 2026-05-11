// src/cli/commands/jobs-reload.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function jobsReload(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const result = await request('/internal/jobs/reload');
  if (result?.ok) {
    out(`reloaded — ${result.count ?? 0} jobs discovered`);
  } else {
    err(`reload failed: ${result?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
