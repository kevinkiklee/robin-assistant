import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { detectUpstreamHookChange } from '../../scripts/lib/preflight.js';

describe('preflight: detectUpstreamHookChange', () => {
  it('returns isUpstreamDriven=true when working tree matches HEAD but manifest is stale', () => {
    const ws = mkdtempSync(join(tmpdir(), 'robin-preflight-'));
    try {
      mkdirSync(join(ws, '.claude'), { recursive: true });
      mkdirSync(join(ws, 'user-data/runtime/security'), { recursive: true });

      const settings = { hooks: { PostToolUse: [{ matcher: 'Write' }] } };
      writeFileSync(join(ws, '.claude/settings.json'), JSON.stringify(settings, null, 2));

      // Manifest with an OLD hooks hash → simulates pre-upgrade state.
      writeFileSync(
        join(ws, 'user-data/runtime/security/manifest.json'),
        JSON.stringify({ hooksHash: 'old-stale-hash' }, null, 2),
      );

      execSync(
        'git init -q && git add . && git -c user.email=t@t.t -c user.name=t commit -q -m init',
        { cwd: ws, stdio: 'pipe' },
      );

      const result = detectUpstreamHookChange(ws);
      assert.equal(
        result.isUpstreamDriven,
        true,
        'working tree matches HEAD + stale manifest → upstream-driven',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns isUpstreamDriven=false when working tree differs from HEAD (local customization)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'robin-preflight-'));
    try {
      mkdirSync(join(ws, '.claude'), { recursive: true });
      mkdirSync(join(ws, 'user-data/runtime/security'), { recursive: true });

      // HEAD has only Stop hook
      writeFileSync(
        join(ws, '.claude/settings.json'),
        JSON.stringify({ hooks: { Stop: [] } }, null, 2),
      );
      execSync(
        'git init -q && git add . && git -c user.email=t@t.t -c user.name=t commit -q -m init',
        { cwd: ws, stdio: 'pipe' },
      );

      // Working tree adds a custom hook (not committed).
      writeFileSync(
        join(ws, '.claude/settings.json'),
        JSON.stringify({ hooks: { Stop: [], CustomHook: [] } }, null, 2),
      );

      writeFileSync(
        join(ws, 'user-data/runtime/security/manifest.json'),
        JSON.stringify({ hooksHash: 'pre-customization-hash' }, null, 2),
      );

      const result = detectUpstreamHookChange(ws);
      assert.equal(
        result.isUpstreamDriven,
        false,
        'working tree differs from HEAD → local customization, not upstream-driven',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns isUpstreamDriven=false when in-sync (current === recorded hash)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'robin-preflight-'));
    try {
      mkdirSync(join(ws, '.claude'), { recursive: true });
      mkdirSync(join(ws, 'user-data/runtime/security'), { recursive: true });

      const settings = { hooks: {} };
      writeFileSync(join(ws, '.claude/settings.json'), JSON.stringify(settings, null, 2));

      // Compute the expected hash inline using the same canonicalization
      // as detectUpstreamHookChange's hashHooksBlock helper.
      const { createHash } = await import('node:crypto');
      const hooks = settings.hooks;
      const canonical = JSON.stringify(hooks, Object.keys(hooks).sort());
      const expectedHash = createHash('sha256').update(canonical).digest('hex');

      writeFileSync(
        join(ws, 'user-data/runtime/security/manifest.json'),
        JSON.stringify({ hooksHash: expectedHash }, null, 2),
      );

      execSync(
        'git init -q && git add . && git -c user.email=t@t.t -c user.name=t commit -q -m init',
        { cwd: ws, stdio: 'pipe' },
      );

      const result = detectUpstreamHookChange(ws);
      assert.equal(result.isUpstreamDriven, false);
      assert.equal(result.reason, 'in-sync');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
