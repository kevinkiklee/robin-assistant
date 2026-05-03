import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProtocolFrontmatter,
  validateProtocolFrontmatter,
  validateAllProtocols,
  listProtocols,
  listProtocolsWithFrontmatter,
} from '../../scripts/lib/protocol-frontmatter.js';

function makeJobsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('parseProtocolFrontmatter', () => {
  it('parses dispatch and model fields', () => {
    const text = `---
name: dream
dispatch: subagent
model: opus
triggers: ["dream", "memory check"]
description: Daily maintenance.
---
# Body
content here`;
    const { frontmatter, body } = parseProtocolFrontmatter(text);
    assert.equal(frontmatter.dispatch, 'subagent');
    assert.equal(frontmatter.model, 'opus');
    assert.equal(frontmatter.name, 'dream');
    assert.deepEqual(frontmatter.triggers, ['dream', 'memory check']);
    assert.equal(frontmatter.description, 'Daily maintenance.');
    assert.match(body, /^# Body/);
  });

  it('returns empty frontmatter for files without it', () => {
    const { frontmatter, body } = parseProtocolFrontmatter('# Just a body\nno frontmatter');
    assert.deepEqual(frontmatter, {});
    assert.match(body, /^# Just a body/);
  });

  it('parses booleans and numbers', () => {
    const text = `---
enabled: true
catch_up: false
timeout_minutes: 30
---
body`;
    const { frontmatter } = parseProtocolFrontmatter(text);
    assert.equal(frontmatter.enabled, true);
    assert.equal(frontmatter.catch_up, false);
    assert.equal(frontmatter.timeout_minutes, 30);
  });
});

describe('validateProtocolFrontmatter', () => {
  it('returns no issues for valid dispatch + model', () => {
    const issues = validateProtocolFrontmatter('test', { dispatch: 'subagent', model: 'opus' });
    assert.deepEqual(issues, []);
  });

  it('flags missing dispatch', () => {
    const issues = validateProtocolFrontmatter('test', { model: 'opus' });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /missing 'dispatch'/);
  });

  it('flags missing model', () => {
    const issues = validateProtocolFrontmatter('test', { dispatch: 'inline' });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /missing 'model'/);
  });

  it('flags invalid dispatch value', () => {
    const issues = validateProtocolFrontmatter('test', { dispatch: 'parallel', model: 'opus' });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /invalid dispatch/);
  });

  it('flags invalid model value', () => {
    const issues = validateProtocolFrontmatter('test', { dispatch: 'inline', model: 'gpt-5' });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /invalid model/);
  });

  it('accepts all three valid models', () => {
    for (const m of ['opus', 'sonnet', 'haiku']) {
      const issues = validateProtocolFrontmatter('test', { dispatch: 'inline', model: m });
      assert.deepEqual(issues, [], `should accept model=${m}`);
    }
  });
});

describe('listProtocols and validateAllProtocols', () => {
  it('lists protocol files, skipping README and _-prefixed', () => {
    const dir = makeJobsDir({
      'README.md': 'readme content',
      '_robin-sync.md': 'helper, skip',
      'dream.md': '---\ndispatch: subagent\nmodel: opus\n---\n',
      'lint.md': '---\ndispatch: subagent\nmodel: sonnet\n---\n',
    });
    const list = listProtocols(dir);
    assert.deepEqual(list, ['dream', 'lint']);
  });

  it('validateAllProtocols flags protocols missing frontmatter', () => {
    const dir = makeJobsDir({
      'good.md': '---\ndispatch: inline\nmodel: opus\n---\n',
      'bad.md': '---\nname: bad\n---\nno dispatch or model',
    });
    const issues = validateAllProtocols(dir);
    assert.equal(issues.length, 2);
    assert.ok(issues.some((i) => i.includes('bad') && i.includes("missing 'dispatch'")));
    assert.ok(issues.some((i) => i.includes('bad') && i.includes("missing 'model'")));
  });

  it('listProtocolsWithFrontmatter returns parsed frontmatter per file', () => {
    const dir = makeJobsDir({
      'a.md': '---\ndispatch: subagent\nmodel: sonnet\n---\nbody',
      'b.md': '---\ndispatch: inline\nmodel: opus\n---\nbody',
    });
    const list = listProtocolsWithFrontmatter(dir);
    assert.equal(list.length, 2);
    assert.equal(list.find((p) => p.name === 'a').frontmatter.dispatch, 'subagent');
    assert.equal(list.find((p) => p.name === 'b').frontmatter.dispatch, 'inline');
  });
});
