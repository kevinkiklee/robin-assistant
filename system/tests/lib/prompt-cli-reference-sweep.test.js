// system/tests/lib/prompt-cli-reference-sweep.test.js
//
// Trip-wire: production prompt files (CLAUDE.md, system/rules/, system/jobs/,
// README.md) must not reference per-turn CLI commands that the PostToolUse
// hook + native Grep tool now cover. Excludes user-data/memory/self-improvement/
// because those are historical correction records.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

describe('lib: prompt CLI reference sweep', () => {
  it('no production prompt file invokes `robin recall`, `robin link`, or `node bin/robin.js (link|recall|regenerate)`', () => {
    let hits;
    try {
      hits = execFileSync(
        'grep',
        [
          '-rn',
          '-E',
          'robin recall|robin link|node bin/robin\\.js (recall|link|regenerate)',
          'CLAUDE.md', 'README.md', 'system/rules/', 'system/jobs/',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      // grep exits 1 when there are no matches — that's the success case here.
      if (e.status === 1) return;
      throw e;
    }
    assert.fail(
      'production prompts still reference removed CLI commands:\n' + hits,
    );
  });
});
