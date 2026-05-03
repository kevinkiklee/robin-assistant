import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measurePrefixBloatFromJsonl, measureTokenUsageFromJsonl } from '../../scripts/diagnostics/measure-prefix-bloat.js';

function writeFixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'pbb-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, content);
  return path;
}

describe('measure-prefix-bloat', () => {
  it('counts skill descriptions from system-reminder', () => {
    const reminder = `<system-reminder>
The following skills are available for use with the Skill tool:

- skill-a: description for skill a
- skill-b: description for skill b
- skill-c: description for skill c
</system-reminder>`;

    const fixture = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: reminder }],
    }) + '\n';

    const path = writeFixture(fixture);
    const result = measurePrefixBloatFromJsonl(path);

    assert.equal(result.skillCount, 3, 'three skills counted');
    assert.ok(result.tokens > 0, 'positive token estimate');
    assert.ok(result.bytes > 0, 'positive byte count');
  });

  it('returns zero counts when no system-reminder present', () => {
    const fixture = JSON.stringify({
      role: 'user',
      content: 'plain text',
    }) + '\n';
    const path = writeFixture(fixture);
    const result = measurePrefixBloatFromJsonl(path);
    assert.equal(result.skillCount, 0);
    assert.equal(result.deferredToolCount, 0);
    assert.equal(result.reminderCount, 0);
  });

  it('counts deferred tool names from the deferred-tools system-reminder', () => {
    const reminder = `<system-reminder>
The following deferred tools are now available via ToolSearch.
ToolA
ToolB
ToolC
mcp__server__tool
</system-reminder>`;
    const fixture = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: reminder }],
    }) + '\n';
    const path = writeFixture(fixture);
    const result = measurePrefixBloatFromJsonl(path);
    assert.ok(result.deferredToolCount >= 4, `expected ≥4 deferred tools, got ${result.deferredToolCount}`);
  });

  it('handles message-wrapped content shape (Claude Code session JSONL)', () => {
    const reminder = `<system-reminder>
The following skills are available for use with the Skill tool:

- foo:bar: a thing
- baz: another
</system-reminder>`;
    const fixture = JSON.stringify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: reminder }],
      },
    }) + '\n';
    const path = writeFixture(fixture);
    const result = measurePrefixBloatFromJsonl(path);
    assert.equal(result.skillCount, 2);
  });

  it('aggregates token usage from assistant messages (primary signal)', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 30000,
            cache_read_input_tokens: 5000,
            output_tokens: 500,
            cache_creation: { ephemeral_1h_input_tokens: 30000, ephemeral_5m_input_tokens: 0 },
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 36000,
            output_tokens: 800,
          },
        },
      }),
    ].join('\n') + '\n';
    const path = writeFixture(lines);
    const result = measureTokenUsageFromJsonl(path);
    assert.equal(result.turns, 2);
    assert.equal(result.sum.cacheWrite, 30000);
    assert.equal(result.sum.cacheRead, 41000);
    assert.equal(result.sum.fresh, 15);
    assert.equal(result.sum.prefix, 71015);
    assert.equal(result.mean.prefix, 71015 / 2);
  });

  it('returns null mean when no assistant messages are present', () => {
    const path = writeFixture('');
    const result = measureTokenUsageFromJsonl(path);
    assert.equal(result.turns, 0);
    assert.equal(result.mean, null);
  });

  it('firstTurnOnly stops after the first assistant message', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 2, cache_creation_input_tokens: 300, cache_read_input_tokens: 400, output_tokens: 60 } } }),
    ].join('\n') + '\n';
    const path = writeFixture(lines);
    const all = measureTokenUsageFromJsonl(path);
    const first = measureTokenUsageFromJsonl(path, { firstTurnOnly: true });
    assert.equal(all.turns, 2);
    assert.equal(first.turns, 1);
    assert.equal(first.sum.prefix, 301);
  });

  it('aggregates across multiple system-reminders in one session', () => {
    const skillsReminder = `<system-reminder>
The following skills are available for use with the Skill tool:

- one: x
- two: y
</system-reminder>`;
    const deferredReminder = `<system-reminder>
The following deferred tools are now available via ToolSearch.
A
B
C
</system-reminder>`;
    const lines = [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: skillsReminder }] }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: deferredReminder }] }),
    ].join('\n') + '\n';
    const path = writeFixture(lines);
    const result = measurePrefixBloatFromJsonl(path);
    assert.equal(result.skillCount, 2);
    assert.equal(result.deferredToolCount, 3);
    assert.equal(result.reminderCount, 2);
  });
});
