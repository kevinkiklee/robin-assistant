// DEPRECATED — startup-check.js is a compatibility shim.
// The pre-flight pipeline has moved to system/scripts/lib/preflight.js.
// Import runPreflight from there for all new callers.
// This shim will be removed in a future minor version.

import { runPreflight } from './lib/preflight.js';

let _deprecationLogged = false;

function warnDeprecation() {
  if (_deprecationLogged) return;
  _deprecationLogged = true;
  process.stderr.write(
    '[startup-check] DEPRECATED: startup-check.js is a shim. ' +
    'Import runPreflight from system/scripts/lib/preflight.js instead. ' +
    'This file will be removed in a future minor version.\n'
  );
}

export async function runStartupCheck(workspaceDir = process.cwd()) {
  warnDeprecation();
  return runPreflight(workspaceDir);
}

function report(findings) {
  for (const f of findings) console.log(`${f.level}: ${f.message}`);
  if (findings.some(f => f.level === 'FATAL')) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  warnDeprecation();
  const r = await runPreflight();
  report(r.findings);
}
