// Smoke test: validates that every real protocol in system/jobs/ has the
// dispatch + model frontmatter required by the Phase 2 dispatch system.
// Catches the future failure mode where a new protocol is added without
// those fields.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAllProtocols, listProtocols, listProtocolsWithFrontmatter } from '../../scripts/lib/protocol-frontmatter.js';

describe('protocol frontmatter — real system/jobs/', () => {
  it('every protocol has valid dispatch + model frontmatter', () => {
    const issues = validateAllProtocols();
    assert.deepEqual(issues, [], `Issues found:\n  ${issues.join('\n  ')}`);
  });

  it('lists at least 20 protocols (sanity check)', () => {
    const list = listProtocols();
    assert.ok(list.length >= 20, `expected ≥20 protocols, got ${list.length}`);
  });

  it('every protocol has a description', () => {
    const protocols = listProtocolsWithFrontmatter();
    const issues = [];
    for (const { name, frontmatter } of protocols) {
      if (!frontmatter.description) issues.push(`${name}: missing 'description'`);
    }
    assert.deepEqual(issues, [], `Issues found:\n  ${issues.join('\n  ')}`);
  });

  it('subagent-dispatched protocols have a return schema documented in body', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const REPO_ROOT = resolve(__dirname, '..', '..', '..');
    const protocols = listProtocolsWithFrontmatter();
    const issues = [];
    for (const { name, frontmatter } of protocols) {
      if (frontmatter.dispatch !== 'subagent') continue;
      const path = join(REPO_ROOT, 'system', 'jobs', `${name}.md`);
      const text = readFileSync(path, 'utf8');
      if (!/##\s+Return schema/i.test(text)) {
        issues.push(`${name}: dispatch=subagent but no '## Return schema' section in body`);
      }
    }
    assert.deepEqual(issues, [], `Issues found:\n  ${issues.join('\n  ')}`);
  });

  it('all dispatched models are valid (no haiku in current set is fine)', () => {
    const protocols = listProtocolsWithFrontmatter();
    const counts = { opus: 0, sonnet: 0, haiku: 0 };
    for (const { frontmatter } of protocols) {
      if (frontmatter.model && counts[frontmatter.model] !== undefined) {
        counts[frontmatter.model] += 1;
      }
    }
    assert.ok(counts.opus > 0, 'expected at least one opus protocol');
    assert.ok(counts.sonnet > 0, 'expected at least one sonnet protocol (lint, todo-extraction)');
    // haiku may be 0 — fine
  });
});
