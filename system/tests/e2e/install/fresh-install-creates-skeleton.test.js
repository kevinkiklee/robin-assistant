// system/tests/e2e/install/fresh-install-creates-skeleton.test.js
//
// Verifies that `npm install robin-assistant` scaffolds the expected
// user-data/memory/ tree via the postinstall script.
//
// We snapshot user-data/memory because it is the deterministic portion of
// the postinstall output — a direct copy of system/scaffold/memory with no
// dynamic substitutions. Everything else postinstall writes is either
// timestamp-stamped (backup/, jobs/upcoming.md, jobs/INDEX.md) or contains
// the absolute install path (jobs/workspace-path), which would make stable
// snapshot assertions impractical.

import { describe, it } from 'node:test';
import { runInstallScenario } from '../../lib/install-scenario.js';

describe('e2e: install: fresh install creates skeleton', () => {
  it('npm install scaffolds user-data/memory via postinstall', { timeout: 120_000 }, async () => {
    await runInstallScenario({
      fixture: 'install/fresh-install-creates-skeleton',
      clock: '2026-05-02T12:00:00Z',
      // Capture the memory subtree — deterministic scaffold copy.
      captureSubpath: 'node_modules/robin-assistant/user-data/memory',
      // Smoke-test that other key paths exist even though we don't snapshot them.
      mustExist: [
        'node_modules/robin-assistant/bin/robin.js',
        'node_modules/robin-assistant/user-data/runtime/config/robin.config.json',
        'node_modules/robin-assistant/user-data/runtime/security/manifest.json',
        'node_modules/robin-assistant/user-data/runtime/state/sessions.md',
      ],
    });
  });
});
