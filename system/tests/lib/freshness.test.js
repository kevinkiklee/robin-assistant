// Unit tests for system/scripts/lib/freshness.js.
//
// Covers atomic stamping, idempotency, frontmatter insertion when none exists,
// the missing/null/future/invalid edge cases for isFresh.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampLastSynced, isFresh, getLastSynced } from '../../scripts/lib/freshness.js';

function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-'));
  const path = join(dir, 'whoop.md');
  writeFileSync(path, content);
  return { dir, path };
}

describe('freshness.js', () => {
  describe('stampLastSynced', () => {
    it('inserts last_synced into existing frontmatter', () => {
      const { path } = tmpFile('---\ntype: snapshot\n---\n\nbody\n');
      stampLastSynced(path, '2026-05-03T12:00:00Z');
      const text = readFileSync(path, 'utf8');
      assert.match(text, /last_synced: 2026-05-03T12:00:00Z/);
      assert.match(text, /type: snapshot/);
      assert.match(text, /\nbody\n/);
    });

    it('updates an existing last_synced field in place', () => {
      const { path } = tmpFile('---\nlast_synced: 2026-04-30T00:00:00Z\ntype: snapshot\n---\n\nbody\n');
      stampLastSynced(path, '2026-05-03T12:00:00Z');
      const text = readFileSync(path, 'utf8');
      assert.match(text, /last_synced: 2026-05-03T12:00:00Z/);
      // Should not contain both timestamps.
      assert.equal((text.match(/last_synced:/g) || []).length, 1);
      assert.match(text, /type: snapshot/);
    });

    it('inserts a frontmatter block when none exists', () => {
      const { path } = tmpFile('# header only\n\nbody\n');
      stampLastSynced(path, '2026-05-03T12:00:00Z');
      const text = readFileSync(path, 'utf8');
      assert.match(text, /^---\nlast_synced: 2026-05-03T12:00:00Z\n---\n/);
      assert.match(text, /# header only/);
    });

    it('writes atomically (no .tmp left behind on success)', () => {
      const { dir, path } = tmpFile('---\ntype: snapshot\n---\n');
      stampLastSynced(path, '2026-05-03T12:00:00Z');
      const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp'));
      assert.deepEqual(leftovers, []);
    });

    it('throws when the file does not exist', () => {
      assert.throws(() => stampLastSynced('/nonexistent/path/whoop.md'));
    });

    it('returns the timestamp it wrote', () => {
      const { path } = tmpFile('---\ntype: snapshot\n---\n');
      const ts = stampLastSynced(path, '2026-05-03T12:00:00Z');
      assert.equal(ts, '2026-05-03T12:00:00Z');
    });

    it('defaults to now when ts is omitted', () => {
      const { path } = tmpFile('---\ntype: snapshot\n---\n');
      const before = Date.now();
      const ts = stampLastSynced(path);
      const after = Date.now();
      const t = Date.parse(ts);
      assert.ok(t >= before && t <= after, `expected ${ts} to be within [${before}, ${after}]`);
    });
  });

  describe('getLastSynced', () => {
    it('returns the ISO string from frontmatter', () => {
      const { path } = tmpFile('---\nlast_synced: 2026-05-03T12:00:00Z\n---\n');
      assert.equal(getLastSynced(path), '2026-05-03T12:00:00Z');
    });

    it('returns null when the field is absent', () => {
      const { path } = tmpFile('---\ntype: snapshot\n---\n');
      assert.equal(getLastSynced(path), null);
    });

    it('returns null when frontmatter is absent', () => {
      const { path } = tmpFile('# no frontmatter\n');
      assert.equal(getLastSynced(path), null);
    });

    it('returns null when the file is missing', () => {
      assert.equal(getLastSynced('/nonexistent/path.md'), null);
    });
  });

  describe('isFresh', () => {
    it('returns true when within the window', () => {
      const ts = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
      const { path } = tmpFile(`---\nlast_synced: ${ts}\n---\n`);
      assert.equal(isFresh(path, 24), true);
    });

    it('returns false when outside the window', () => {
      const ts = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const { path } = tmpFile(`---\nlast_synced: ${ts}\n---\n`);
      assert.equal(isFresh(path, 24), false);
    });

    it('boundary: exactly maxAgeHours is fresh', () => {
      const ts = new Date(Date.now() - 24 * 3600 * 1000 + 100).toISOString();
      const { path } = tmpFile(`---\nlast_synced: ${ts}\n---\n`);
      assert.equal(isFresh(path, 24), true);
    });

    it('returns true for future timestamps (clock skew)', () => {
      const ts = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { path } = tmpFile(`---\nlast_synced: ${ts}\n---\n`);
      assert.equal(isFresh(path, 24), true);
    });

    it('returns null when last_synced is missing', () => {
      const { path } = tmpFile('---\ntype: snapshot\n---\n');
      assert.equal(isFresh(path), null);
    });

    it('returns null when last_synced is unparseable', () => {
      const { path } = tmpFile('---\nlast_synced: not-a-date\n---\n');
      assert.equal(isFresh(path), null);
    });

    it('returns null when the file is missing', () => {
      assert.equal(isFresh('/nonexistent/whoop.md'), null);
    });
  });
});
