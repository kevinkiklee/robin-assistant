import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import test from 'node:test';
import { secretsPaths } from './store.ts';
import {
  clearOp,
  closeWindow,
  isExpired,
  readOp,
  readWindow,
  type SecretWindow,
  takeArmSession,
  updateWindow,
  writeArmSession,
  writeOp,
  writeWindow,
} from './window.ts';

const dir = () => mkdtempSync(join0());
function join0() {
  return `${tmpdir()}/robin-win-`;
}
const win: SecretWindow = {
  sessionId: 's1',
  tabId: 7,
  provider: 'acme',
  name: 'ACME_KEY',
  scriptHashes: ['h1'],
  clipboardHashAtArm: 'c1',
  openedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:02:00.000Z',
  status: 'open',
};

test('op round-trip and clear', () => {
  const u = dir();
  assert.equal(readOp(u), null);
  const op = {
    provider: 'acme',
    name: 'ACME_KEY',
    mode: 'create' as const,
    targets: [],
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  writeOp(u, op);
  assert.deepEqual(readOp(u), op);
  assert.equal(statSync(secretsPaths(u).op).mode & 0o777, 0o600);
  clearOp(u);
  assert.equal(readOp(u), null);
  clearOp(u);
});

test('window round-trip, update, close', () => {
  const u = dir();
  assert.equal(readWindow(u), null);
  writeWindow(u, win);
  assert.deepEqual(readWindow(u), win);
  assert.equal(statSync(secretsPaths(u).window).mode & 0o777, 0o600);
  updateWindow(u, { status: 'saved' });
  assert.equal(readWindow(u)?.status, 'saved');
  closeWindow(u);
  assert.equal(readWindow(u), null);
});

test('readWindow throws on unparseable content', () => {
  const u = dir();
  const p = secretsPaths(u).window;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{bad json');
  assert.throws(() => readWindow(u));
});

test('arm session is consumed once and valid 10 s', () => {
  const u = dir();
  const at = new Date('2026-01-01T00:00:00.000Z');
  writeArmSession(u, { sessionId: 's1', tabId: 3, at: at.toISOString() });
  assert.deepEqual(takeArmSession(u, new Date(at.getTime() + 5000)), { sessionId: 's1', tabId: 3 });
  assert.equal(takeArmSession(u, new Date(at.getTime() + 5000)), null);
  writeArmSession(u, { sessionId: 's1', tabId: 3, at: at.toISOString() });
  assert.equal(takeArmSession(u, new Date(at.getTime() + 11000)), null);
  assert.equal(takeArmSession(u, at), null);
});

test('isExpired at 119 s / 121 s', () => {
  const o = new Date(win.openedAt).getTime();
  assert.equal(isExpired(win, new Date(o + 119000)), false);
  assert.equal(isExpired(win, new Date(o + 121000)), true);
});
