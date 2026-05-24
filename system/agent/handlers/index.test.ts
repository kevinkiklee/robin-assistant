import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REGISTRY } from './index.ts';

test('barrel import registers all 12 handlers A–L', () => {
  const ids = Object.keys(REGISTRY).sort();
  assert.deepEqual(ids, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
});

test('every registered handler has a build() and a valid trigger', () => {
  for (const h of Object.values(REGISTRY)) {
    assert.equal(typeof h.build, 'function', `${h.id} build`);
    assert.ok(h.trigger === 'on-demand' || h.trigger === 'autonomous', `${h.id} trigger`);
    const cfg = h.build('test goal', { repoRoot: '/repo', worktree: '/repo/.wt' });
    assert.ok(
      Array.isArray(cfg.allowedTools) && cfg.allowedTools.length > 0,
      `${h.id} allowedTools`,
    );
  }
});
