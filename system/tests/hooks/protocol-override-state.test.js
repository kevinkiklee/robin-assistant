// Tests for protocol-override-state.js — atomic per-session state I/O.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, statSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readState,
  writeState,
  deleteState,
  markOverrideRead,
  isStateStale,
  stateFilePath,
  STATE_DIR_REL,
  STATE_STALE_MS,
} from '../../scripts/hooks/lib/protocol-override-state.js';

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'pos-'));
  return ws;
}

describe('writeState / readState', () => {
  it('writes atomically and reads back', () => {
    const ws = makeWs();
    const state = {
      session_id: 'abc',
      turn_started_at: '2026-05-03T00:00:00.000Z',
      triggers_fired: ['daily-briefing'],
      overrides_read: [],
    };
    writeState(ws, 'abc', state);
    const got = readState(ws, 'abc');
    assert.deepEqual(got, state);
  });

  it('creates state directory lazily', () => {
    const ws = makeWs();
    const stateDir = join(ws, STATE_DIR_REL);
    assert.equal(existsSync(stateDir), false);
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: [], overrides_read: [] });
    assert.equal(existsSync(stateDir), true);
  });

  it('returns null when state file does not exist', () => {
    const ws = makeWs();
    assert.equal(readState(ws, 'missing'), null);
  });

  it('returns null when state file is corrupt JSON (fail-open)', () => {
    const ws = makeWs();
    const path = stateFilePath(ws, 'corrupt');
    mkdirSync(join(ws, STATE_DIR_REL), { recursive: true });
    writeFileSync(path, '{ this is not json');
    assert.equal(readState(ws, 'corrupt'), null);
  });

  it('overwrites prior state on each write (always-overwrite semantics)', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't1', triggers_fired: ['a'], overrides_read: ['a'] });
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't2', triggers_fired: [], overrides_read: [] });
    const got = readState(ws, 'sid');
    assert.deepEqual(got.triggers_fired, []);
    assert.deepEqual(got.overrides_read, []);
    assert.equal(got.turn_started_at, 't2');
  });

  it('multi-session isolation: writing session B does not affect session A', () => {
    const ws = makeWs();
    writeState(ws, 'A', { session_id: 'A', turn_started_at: 't', triggers_fired: ['daily-briefing'], overrides_read: [] });
    writeState(ws, 'B', { session_id: 'B', turn_started_at: 't', triggers_fired: ['lint'], overrides_read: [] });
    assert.deepEqual(readState(ws, 'A').triggers_fired, ['daily-briefing']);
    assert.deepEqual(readState(ws, 'B').triggers_fired, ['lint']);
  });

  it('does not leave .tmp files behind on success', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: [], overrides_read: [] });
    const stateDir = join(ws, STATE_DIR_REL);
    const files = readdirSync(stateDir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), `Found tmp files: ${files.join(', ')}`);
  });
});

describe('deleteState', () => {
  it('removes the state file and returns true on success', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: [], overrides_read: [] });
    assert.equal(existsSync(stateFilePath(ws, 'sid')), true);
    const ok = deleteState(ws, 'sid');
    assert.equal(ok, true);
    assert.equal(existsSync(stateFilePath(ws, 'sid')), false);
  });

  it('returns true when state file does not exist (idempotent)', () => {
    const ws = makeWs();
    const ok = deleteState(ws, 'missing');
    assert.equal(ok, true);
  });
});

describe('markOverrideRead', () => {
  it('appends protocol to overrides_read (read-modify-atomic-write)', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: ['daily-briefing'], overrides_read: [] });
    markOverrideRead(ws, 'sid', 'daily-briefing');
    const got = readState(ws, 'sid');
    assert.deepEqual(got.overrides_read, ['daily-briefing']);
  });

  it('is idempotent (no duplicate entries)', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: [], overrides_read: ['daily-briefing'] });
    markOverrideRead(ws, 'sid', 'daily-briefing');
    const got = readState(ws, 'sid');
    assert.deepEqual(got.overrides_read, ['daily-briefing']);
  });

  it('no-op when state file does not exist (no crash)', () => {
    const ws = makeWs();
    // Should not throw.
    markOverrideRead(ws, 'missing', 'anything');
    assert.equal(readState(ws, 'missing'), null);
  });
});

describe('isStateStale', () => {
  it('returns false for fresh files', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: [], overrides_read: [] });
    const path = stateFilePath(ws, 'sid');
    assert.equal(isStateStale(path), false);
  });

  it('returns true for files older than STATE_STALE_MS (24h)', () => {
    const ws = makeWs();
    writeState(ws, 'sid', { session_id: 'sid', turn_started_at: 't', triggers_fired: [], overrides_read: [] });
    const path = stateFilePath(ws, 'sid');
    // Backdate mtime to >24h ago.
    const past = (Date.now() - STATE_STALE_MS - 60_000) / 1000;
    utimesSync(path, past, past);
    assert.equal(isStateStale(path), true);
  });

  it('returns true for missing file', () => {
    const ws = makeWs();
    assert.equal(isStateStale(stateFilePath(ws, 'missing')), true);
  });
});
