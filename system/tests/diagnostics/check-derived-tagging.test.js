// Unit tests for the derived-tagging lint.
//
// Verifies:
//   - flags `[fact|origin=sync:chrome]` and other derived-source variants
//   - does NOT flag legitimate `[fact|origin=sync:gmail]` (direct observation)
//   - does NOT flag `[?|origin=sync:chrome]` (correct tag)
//   - respects `# allow-derived-fact: ...` suppression comments

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFile, scanWorkspace, DERIVED_ORIGINS } from '../../scripts/diagnostics/check-derived-tagging.js';

function makeFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'cdt-'));
  const path = join(dir, 'inbox.md');
  writeFileSync(path, content);
  return path;
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'cdt-ws-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  return dir;
}

describe('check-derived-tagging', () => {
  describe('scanFile', () => {
    it('flags [fact|origin=sync:chrome]', () => {
      const path = makeFile(
        '- [fact|origin=sync:chrome|domain=browsing] Active PSN gamer (113 visits to psnprofiles.com)\n',
      );
      const violations = scanFile(path);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].origin, 'sync:chrome');
      assert.match(violations[0].expected, /\[\?\|origin=sync:chrome/);
    });

    it('flags [fact|origin=derived]', () => {
      const path = makeFile('- [fact|origin=derived] Active cooking-content viewer\n');
      const violations = scanFile(path);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].origin, 'derived');
    });

    it('flags [fact|origin=sync:youtube] (subscription list)', () => {
      const path = makeFile('- [fact|origin=sync:youtube|kind=subscription] Subscribed to N\n');
      const violations = scanFile(path);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].origin, 'sync:youtube');
    });

    it('does NOT flag [fact|origin=sync:gmail] (direct-observation source)', () => {
      const path = makeFile('- [fact|origin=sync:gmail] AmEx statement closed 5/1\n');
      const violations = scanFile(path);
      assert.equal(violations.length, 0);
    });

    it('does NOT flag [?|origin=sync:chrome] (correctly uncertain tag)', () => {
      const path = makeFile('- [?|origin=sync:chrome|domain=browsing] 113 visits to psnprofiles.com\n');
      const violations = scanFile(path);
      assert.equal(violations.length, 0);
    });

    it('does NOT flag [fact|origin=user]', () => {
      const path = makeFile('- [fact|origin=user] My dentist is Dr. Park\n');
      const violations = scanFile(path);
      assert.equal(violations.length, 0);
    });

    it('respects # allow-derived-fact: <reason> suppression', () => {
      const path = makeFile(
        '- [fact|origin=sync:chrome] Active gamer (user confirmed in 2026-04-30 chat) # allow-derived-fact: confirmed\n',
      );
      const violations = scanFile(path);
      assert.equal(violations.length, 0);
    });

    it('flags multiple violations on different lines', () => {
      const path = makeFile([
        '- [fact|origin=sync:chrome] Active gamer',
        '- [fact|origin=user] Real fact',
        '- [fact|origin=derived] Cook',
      ].join('\n'));
      const violations = scanFile(path);
      assert.equal(violations.length, 2);
    });

    it('returns [] when the file does not exist', () => {
      const violations = scanFile('/nonexistent/inbox.md');
      assert.deepEqual(violations, []);
    });
  });

  describe('scanWorkspace', () => {
    it('scans inbox.md and returns count + violations', () => {
      const ws = makeWorkspace();
      writeFileSync(
        join(ws, 'user-data/memory/streams/inbox.md'),
        '- [fact|origin=sync:chrome] Active gamer\n- [fact|origin=user] Real fact\n',
      );
      const result = scanWorkspace({
        workspaceDir: ws,
        files: ['user-data/memory/streams/inbox.md'],
      });
      assert.equal(result.scanned, 1);
      assert.equal(result.violations.length, 1);
    });

    it('returns scanned=0 when no files exist', () => {
      const ws = makeWorkspace();
      const result = scanWorkspace({
        workspaceDir: ws,
        files: ['user-data/memory/streams/inbox.md'],
      });
      assert.equal(result.scanned, 0);
      assert.equal(result.violations.length, 0);
    });
  });

  describe('DERIVED_ORIGINS', () => {
    it('includes the documented derived-source list', () => {
      assert.ok(DERIVED_ORIGINS.includes('derived'));
      assert.ok(DERIVED_ORIGINS.includes('sync:chrome'));
      assert.ok(DERIVED_ORIGINS.includes('sync:youtube'));
      assert.ok(DERIVED_ORIGINS.includes('sync:spotify'));
    });
  });
});
