import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHighStakesWrite,
  isHighStakesDestination,
  HIGH_STAKES_DESTINATIONS,
} from '../../scripts/lib/high-stakes-log.js';

const LOG_REL = 'user-data/runtime/state/telemetry/high-stakes-writes.log';

describe('lib: high-stakes-log', () => {
  let workspaceDir;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'hsl-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('appendHighStakesWrite', () => {
    it('creates the log file and writes a single tab-separated line', () => {
      appendHighStakesWrite(workspaceDir, {
        target: 'user-data/memory/tasks.md',
        contentHash: 'abc123',
      });
      const lines = readFileSync(join(workspaceDir, LOG_REL), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      const [ts, target, hash] = lines[0].split('\t');
      assert.ok(!Number.isNaN(Date.parse(ts)), 'timestamp parses as ISO 8601');
      assert.equal(target, 'user-data/memory/tasks.md');
      assert.equal(hash, 'abc123');
    });

    it('creates the parent directory if missing', () => {
      appendHighStakesWrite(workspaceDir, { target: 'x', contentHash: 'h' });
      assert.ok(existsSync(join(workspaceDir, LOG_REL)));
    });

    it('appends multiple distinct entries', () => {
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'h1' });
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'h2' });
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/profile/identity.md', contentHash: 'h1' });
      const lines = readFileSync(join(workspaceDir, LOG_REL), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 3);
    });

    it('dedups (target, contentHash) within a 1h window', () => {
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'same' });
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'same' });
      const lines = readFileSync(join(workspaceDir, LOG_REL), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1, 'duplicate entry within window must not append');
    });

    it('does not dedup if contentHash differs', () => {
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'h1' });
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'h2' });
      const lines = readFileSync(join(workspaceDir, LOG_REL), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 2);
    });

    it('treats undefined contentHash as empty string for dedup', () => {
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md' });
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md' });
      const lines = readFileSync(join(workspaceDir, LOG_REL), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
    });

    it('re-appends an entry that aged out of the dedup window', () => {
      // Pre-seed with an entry timestamped 2 hours ago.
      const logPath = join(workspaceDir, LOG_REL);
      mkdirSync(join(workspaceDir, 'user-data/runtime/state/telemetry'), { recursive: true });
      const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      writeFileSync(logPath, `${oldTs}\tuser-data/memory/tasks.md\told-hash\n`);
      // Same (target, hash) — should NOT dedup since old entry aged out.
      appendHighStakesWrite(workspaceDir, { target: 'user-data/memory/tasks.md', contentHash: 'old-hash' });
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 2, 'aged-out entry should not block re-append');
    });
  });

  describe('isHighStakesDestination', () => {
    it('returns true for every shipped HIGH_STAKES_DESTINATIONS path', () => {
      for (const p of HIGH_STAKES_DESTINATIONS) {
        assert.equal(isHighStakesDestination(p), true, `${p} should be high-stakes`);
      }
    });

    it('returns true when the path ends with a known destination (absolute paths)', () => {
      assert.equal(
        isHighStakesDestination('/some/abs/prefix/user-data/memory/tasks.md'),
        true
      );
    });

    it('returns false for non-high-stakes paths', () => {
      assert.equal(isHighStakesDestination('user-data/memory/journal.md'), false);
      assert.equal(isHighStakesDestination('user-data/memory/inbox.md'), false);
      assert.equal(isHighStakesDestination('random/file.md'), false);
    });

    it('handles backslash path separators (windows-style input)', () => {
      assert.equal(
        isHighStakesDestination('user-data\\memory\\tasks.md'),
        true,
        'backslashes must normalize before match'
      );
    });

    it('returns false for non-string input', () => {
      assert.equal(isHighStakesDestination(undefined), false);
      assert.equal(isHighStakesDestination(null), false);
      assert.equal(isHighStakesDestination(42), false);
    });
  });
});
