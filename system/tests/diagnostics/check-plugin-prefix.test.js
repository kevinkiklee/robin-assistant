import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPluginDrift } from '../../scripts/diagnostics/check-plugin-prefix.js';

function fixtureSession(skills) {
  const reminder = `<system-reminder>
The following skills are available for use with the Skill tool:

${skills.map((s) => `- ${s}: desc`).join('\n')}
</system-reminder>`;
  const dir = mkdtempSync(join(tmpdir(), 'cpp-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, JSON.stringify({ role: 'user', content: [{ type: 'text', text: reminder }] }) + '\n');
  return path;
}

describe('check-plugin-prefix', () => {
  it('returns no drift when all skills are on the whitelist', () => {
    const path = fixtureSession(['superpowers:brainstorming', 'gemini-nano-banana:gen', 'chrome-devtools:click']);
    const whitelist = ['superpowers', 'gemini-nano-banana', 'chrome-devtools', 'context7'];
    const drift = detectPluginDrift(path, whitelist);
    assert.deepEqual(drift.unexpected, []);
  });

  it('flags skills outside the whitelist', () => {
    const path = fixtureSession(['superpowers:brainstorming', 'vercel:deploy', 'stripe:test-cards']);
    const whitelist = ['superpowers', 'gemini-nano-banana', 'chrome-devtools', 'context7'];
    const drift = detectPluginDrift(path, whitelist);
    assert.ok(drift.unexpected.includes('vercel'));
    assert.ok(drift.unexpected.includes('stripe'));
  });

  it('treats bare names (no namespace) as their own namespace', () => {
    const path = fixtureSession(['humanizer', 'init', 'review']);
    const whitelist = ['superpowers'];
    const drift = detectPluginDrift(path, whitelist);
    assert.ok(drift.unexpected.length >= 3);
  });

  it('handles message-wrapped content shape (Claude Code session JSONL)', () => {
    const reminder = `<system-reminder>
The following skills are available for use with the Skill tool:

- foo:bar: a thing
</system-reminder>`;
    const dir = mkdtempSync(join(tmpdir(), 'cpp-'));
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({
      message: { role: 'user', content: [{ type: 'text', text: reminder }] },
    }) + '\n');
    const drift = detectPluginDrift(path, ['superpowers']);
    assert.deepEqual(drift.unexpected, ['foo']);
  });

  it('returns empty result when no skill list reminder is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpp-'));
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ role: 'user', content: 'plain text' }) + '\n');
    const drift = detectPluginDrift(path, ['superpowers']);
    assert.equal(drift.skillsSeen, 0);
    assert.deepEqual(drift.unexpected, []);
  });
});
