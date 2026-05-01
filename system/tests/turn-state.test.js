// system/tests/turn-state.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintTurnId,
  writeTurnJson,
  readTurnJson,
  appendWriteIntent,
  readWriteIntents,
  pruneWriteIntents,
  readRetry,
  incrementRetry,
} from '../scripts/lib/turn-state.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'turn-state-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  return ws;
}

describe('turn-state', () => {
  it('mintTurnId composes session-id and ms timestamp', () => {
    const id = mintTurnId('claude-code-abc', new Date('2026-05-01T12:00:00Z'));
    assert.equal(id, 'claude-code-abc:1777636800000');
  });

  it('writeTurnJson + readTurnJson round-trip', () => {
    const ws = setup();
    writeTurnJson(ws, { turn_id: 't1', user_words: 12, tier: 3, entities_matched: ['x'] });
    const got = readTurnJson(ws);
    assert.equal(got.turn_id, 't1');
    assert.equal(got.tier, 3);
    assert.deepEqual(got.entities_matched, ['x']);
  });

  it('readTurnJson returns null when missing', () => {
    const ws = setup();
    assert.equal(readTurnJson(ws), null);
  });

  it('readTurnJson returns null when corrupt', () => {
    const ws = setup();
    writeFileSync(join(ws, 'user-data/state/turn.json'), '{not-json');
    assert.equal(readTurnJson(ws), null);
  });

  it('appendWriteIntent appends one line per call', () => {
    const ws = setup();
    appendWriteIntent(ws, { turn_id: 't1', target: 'inbox.md', tool: 'Edit' });
    appendWriteIntent(ws, { turn_id: 't1', target: 'profile.md', tool: 'Write' });
    const lines = readWriteIntents(ws, 't1');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].target, 'inbox.md');
    assert.equal(lines[1].tool, 'Write');
  });

  it('readWriteIntents filters by turn_id', () => {
    const ws = setup();
    appendWriteIntent(ws, { turn_id: 't1', target: 'a.md', tool: 'Edit' });
    appendWriteIntent(ws, { turn_id: 't2', target: 'b.md', tool: 'Edit' });
    assert.equal(readWriteIntents(ws, 't1').length, 1);
    assert.equal(readWriteIntents(ws, 't2').length, 1);
  });

  it('pruneWriteIntents drops entries older than cutoff', () => {
    const ws = setup();
    const now = Date.now();
    writeFileSync(join(ws, 'user-data/state/turn-writes.log'),
      `${new Date(now - 2 * 3600_000).toISOString()}\told\tinbox.md\tEdit\n` +
      `${new Date(now - 60_000).toISOString()}\trecent\tinbox.md\tEdit\n`,
    );
    pruneWriteIntents(ws, new Date(now - 3600_000));
    const text = readFileSync(join(ws, 'user-data/state/turn-writes.log'), 'utf8');
    assert.ok(!text.includes('old'));
    assert.ok(text.includes('recent'));
  });

  it('incrementRetry increments per turn_id and reads back', () => {
    const ws = setup();
    assert.equal(readRetry(ws, 't1'), 0);
    assert.equal(incrementRetry(ws, 't1'), 1);
    assert.equal(incrementRetry(ws, 't1'), 2);
    assert.equal(readRetry(ws, 't2'), 0);
  });
});
