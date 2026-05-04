// Tests for check-protocol-triggers.js — lint rule: error if a protocol file
// is missing the `triggers:` key. Empty `triggers: []` is a valid opt-out.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProtocolsMissingTriggers } from '../../scripts/diagnostics/check-protocol-triggers.js';

function makeJobsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cpt-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('findProtocolsMissingTriggers', () => {
  it('returns empty when all protocols declare triggers (including [])', () => {
    const dir = makeJobsDir({
      'a.md': '---\nname: a\ndispatch: inline\nmodel: opus\ntriggers: ["foo"]\n---\nbody',
      'b.md': '---\nname: b\ndispatch: inline\nmodel: opus\ntriggers: []\n---\nbody',
    });
    assert.deepEqual(findProtocolsMissingTriggers(dir), []);
  });

  it('flags protocols with no triggers key at all', () => {
    const dir = makeJobsDir({
      'good.md': '---\nname: good\ntriggers: []\n---\n',
      'bad.md': '---\nname: bad\ndispatch: inline\nmodel: opus\n---\nno triggers field',
    });
    const issues = findProtocolsMissingTriggers(dir);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /bad/);
    assert.match(issues[0], /missing 'triggers'/);
  });

  it('skips _-prefixed and README files (consistent with listProtocols)', () => {
    const dir = makeJobsDir({
      '_robin-sync.md': '---\nname: _robin-sync\n---\n',
      'README.md': '# readme',
      'lint.md': '---\nname: lint\ntriggers: ["lint"]\n---\n',
    });
    assert.deepEqual(findProtocolsMissingTriggers(dir), []);
  });

  it('treats malformed frontmatter (no triggers parsed) as missing', () => {
    const dir = makeJobsDir({
      'broken.md': '# no frontmatter at all\n',
    });
    const issues = findProtocolsMissingTriggers(dir);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /broken/);
  });

  it('current system/jobs/ tree passes after Phase 1 additions', () => {
    // Locate the real system/jobs dir relative to this test.
    const realJobsDir = join(process.cwd(), 'system', 'jobs');
    const issues = findProtocolsMissingTriggers(realJobsDir);
    assert.deepEqual(
      issues,
      [],
      `Some protocols are missing 'triggers:': ${issues.join('\n  ')}`,
    );
  });
});
