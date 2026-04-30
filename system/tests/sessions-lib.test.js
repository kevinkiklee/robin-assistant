import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mostRecentSessionId } from '../scripts/lib/sessions.js';

function workspace(content) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  mkdirSync(join(dir, 'user-data/state'), { recursive: true });
  writeFileSync(join(dir, 'user-data/state/sessions.md'), content);
  return dir;
}

test('mostRecentSessionId: returns most recent claude-code-* row within 2h', () => {
  const now = new Date('2026-04-30T21:00:00Z');
  const ws = workspace(`# Active sessions

| Session | Last active |
|---------|-------------|
| claude-code-20260430-2000 | 2026-04-30T20:55:00Z |
| cursor-20260430-1900 | 2026-04-30T19:55:00Z |
`);
  const id = mostRecentSessionId(ws, 'claude-code', { now });
  assert.equal(id, 'claude-code-20260430-2000');
});

test('mostRecentSessionId: returns null when no claude-code-* row is recent', () => {
  const now = new Date('2026-04-30T21:00:00Z');
  const ws = workspace(`# Active sessions

| Session | Last active |
|---------|-------------|
| claude-code-20260430-1500 | 2026-04-30T15:00:00Z |
`);
  const id = mostRecentSessionId(ws, 'claude-code', { now });
  assert.equal(id, null);
});

test('mostRecentSessionId: returns null when sessions.md missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const id = mostRecentSessionId(dir, 'claude-code', { now: new Date() });
  assert.equal(id, null);
});
