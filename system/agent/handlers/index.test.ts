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

test('every edit-capable handler runs inside the fail-closed OS sandbox', () => {
  // acceptEdits approves edits at ANY path and canUseTool is skipped whenever a
  // permission rule decides first — the sandbox is the only real boundary. K and
  // J shipped without one and K committed on the live main (2026-10-02).
  const ctx = { repoRoot: '/repo', worktree: '/repo/.worktrees/x' };
  for (const def of Object.values(REGISTRY)) {
    const built = def.build('g', ctx);
    if (built.permissionMode !== 'acceptEdits') continue;
    const sb = built.sandbox as { enabled?: boolean; failIfUnavailable?: boolean } | undefined;
    assert.equal(sb?.enabled, true, `${def.id} edits files but has no sandbox`);
    assert.equal(sb?.failIfUnavailable, true, `${def.id} sandbox must fail closed`);
  }
});
