// Phase B.2 Task 11 — reshape doctor results into realm-grouped JSON for the
// `health()` MCP tool. The helper is agent-facing: no remediation strings
// (those live on the invariant `class` and the agent looks them up itself).

import assert from 'node:assert';
import test from 'node:test';
import { reshapeForMCP } from '../../io/format/doctor-health.js';

test('reshapeForMCP groups checks by realm and rolls up worst status', () => {
  const r = reshapeForMCP({
    results: [
      { name: 'db.a', surface: 'db', status: 'ok' },
      { name: 'db.b', surface: 'db', status: 'warn', error: 'm' },
      { name: 'paths.x', surface: 'paths', status: 'ok' },
    ],
    ts: '2026-05-17T13:42:01Z',
    summary: { ok: 2, warn: 1, fail: 0 },
  });
  assert.strictEqual(r.ts, '2026-05-17T13:42:01Z');
  assert.deepStrictEqual(r.summary, { ok: 2, warn: 1, fail: 0 });
  assert.strictEqual(r.realms.db.status, 'warn');
  assert.strictEqual(r.realms.paths.status, 'ok');
  assert.strictEqual(r.realms.db.checks.length, 2);
  assert.strictEqual(r.realms.db.checks[1].error, 'm');
});

test('reshapeForMCP omits remediation strings (agent-facing)', () => {
  const r = reshapeForMCP({
    results: [{ name: 'x', surface: 's', status: 'warn', error: 'm', remediation: 'fix it' }],
    ts: '<ts>',
    summary: { ok: 0, warn: 1, fail: 0 },
  });
  assert.strictEqual(r.realms.s.checks[0].remediation, undefined);
});

test('reshapeForMCP rolls up to fail when any check fails', () => {
  const r = reshapeForMCP({
    results: [
      { name: 'db.a', surface: 'db', status: 'warn', error: 'w' },
      { name: 'db.b', surface: 'db', status: 'fail', error: 'f' },
      { name: 'db.c', surface: 'db', status: 'ok' },
    ],
    ts: '<ts>',
    summary: { ok: 1, warn: 1, fail: 1 },
  });
  assert.strictEqual(r.realms.db.status, 'fail');
});

test('reshapeForMCP normalizes missing error to null', () => {
  const r = reshapeForMCP({
    results: [{ name: 'x', surface: 's', status: 'ok' }],
    ts: '<ts>',
    summary: { ok: 1, warn: 0, fail: 0 },
  });
  assert.strictEqual(r.realms.s.checks[0].error, null);
});

test('reshapeForMCP handles missing surface as "other"', () => {
  const r = reshapeForMCP({
    results: [{ name: 'x', status: 'ok' }],
    ts: '<ts>',
    summary: { ok: 1, warn: 0, fail: 0 },
  });
  assert.ok(r.realms.other);
  assert.strictEqual(r.realms.other.checks[0].name, 'x');
});
