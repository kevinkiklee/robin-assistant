// Phase B.2 Task 8 — realm-grouped doctor output with inline remediation.
//
// `renderDoctor({ results, ts })` returns a single string. Each result has:
//   { name, surface, status: 'ok'|'warn'|'fail', error?, remediation? }
// Results are grouped by `surface` realm. Each realm gets a one-line summary
// (`<realm> <realm-status> <N> check(s)[ (X warn, Y fail)]`), followed by
// per-warn / per-fail detail lines and indented remediation steps. The
// trailing `Summary:` line counts ok/warn/fail across all realms and reports
// `Exit 0` (no fails) or `Exit 1` (any fail).

import assert from 'node:assert';
import test from 'node:test';
import { renderDoctor } from '../../runtime/cli/commands/_doctor-status.js';

function makeResult(name, surface, status, error, remediation) {
  return { name, surface, status, error, remediation };
}

test('renderDoctor groups by realm with realm summary lines', () => {
  const results = [
    makeResult('db.authenticated', 'db', 'ok'),
    makeResult('db.daemon_reachable', 'db', 'ok'),
    makeResult('paths.install', 'paths', 'ok'),
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /db\s+ok\s+2 checks/);
  assert.match(out, /paths\s+ok\s+1 check/);
  assert.match(out, /Summary:\s+3 ok,\s+0 warn,\s+0 fail/);
  assert.match(out, /Exit 0/);
});

test('renderDoctor renders warn detail with remediation', () => {
  const results = [
    makeResult('db.authenticated', 'db', 'ok'),
    makeResult(
      'db.embedder_profile_match',
      'db',
      'warn',
      'active=mxbai-1024, table=mxbai-1024-v2 (mismatched)',
      ['robin embeddings activate mxbai-1024-v2', 'robin embeddings backfill mxbai-1024'],
    ),
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /db\s+warn\s+2 checks \(1 warn\)/);
  assert.match(out, /⚠ db\.embedder_profile_match/);
  assert.match(out, /→ robin embeddings activate mxbai-1024-v2/);
  assert.match(out, /→ robin embeddings backfill mxbai-1024/);
});

test('renderDoctor exits 1 on any fail', () => {
  const results = [
    makeResult('install.pointer_present', 'paths', 'fail', 'pointer file missing at .robin-home', [
      'robin install',
    ]),
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /Summary:.+0 ok.+0 warn.+1 fail/);
  assert.match(out, /Exit 1/);
});

test('renderDoctor exits 0 on warn-only', () => {
  const results = [makeResult('db.embedder_profile_match', 'db', 'warn', 'msg', ['fix'])];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /Exit 0/);
});

test('renderDoctor verbose shows last_passed provenance under each check', () => {
  const results = [
    {
      name: 'db.authenticated',
      surface: 'db',
      status: 'ok',
      lastPassedTs: '2026-05-17T13:00:00Z',
    },
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z', verbose: true });
  assert.match(out, /last_passed: 2026-05-17T13:00:00Z/);
});

test('renderDoctor verbose falls back to "never" when lastPassedTs is missing', () => {
  const results = [
    { name: 'db.fresh', surface: 'db', status: 'ok' },
    { name: 'db.broken', surface: 'db', status: 'warn', error: 'msg', remediation: ['fix'] },
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z', verbose: true });
  // Both rendered checks should get a `last_passed:` line. The `ok` row has no
  // lastPassedTs in this fixture, so it falls back to "never"; the `warn` row
  // also has no provenance attached, falling back to "never" too.
  const matches = out.match(/last_passed: never/g) ?? [];
  assert.strictEqual(matches.length, 2);
});

test('renderDoctor non-verbose mode omits last_passed lines', () => {
  const results = [
    {
      name: 'db.authenticated',
      surface: 'db',
      status: 'ok',
      lastPassedTs: '2026-05-17T13:00:00Z',
    },
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.doesNotMatch(out, /last_passed/);
});

test('renderDoctor with colors:true wraps warn sigil in ANSI yellow', () => {
  const results = [
    {
      name: 'db.embedder_profile_match',
      surface: 'db',
      status: 'warn',
      error: 'mismatched',
      remediation: ['fix'],
    },
  ];
  const out = renderDoctor({ results, ts: '<ts>', colors: true });
  assert.match(out, /\x1b\[33m/);
  assert.match(out, /\x1b\[0m/);
});

test('renderDoctor with colors:false emits no ANSI escapes', () => {
  const results = [
    {
      name: 'db.embedder_profile_match',
      surface: 'db',
      status: 'warn',
      error: 'mismatched',
      remediation: ['fix'],
    },
  ];
  const out = renderDoctor({ results, ts: '<ts>', colors: false });
  assert.doesNotMatch(out, /\x1b\[/);
});
