import test from 'node:test';
import assert from 'node:assert';
import { normalize, normalizeDoctorOutput } from '../helpers/normalize-snapshot.js';

test('normalize replaces ISO timestamps with <TIMESTAMP>', () => {
  const input = 'started at 2026-05-17T13:42:01.123Z and ended at 2026-05-17T13:43:00Z';
  const out = normalize(input);
  assert.strictEqual(out, 'started at <TIMESTAMP> and ended at <TIMESTAMP>');
});

test('normalize replaces surreal record ids with <ID>', () => {
  const input = 'fetched events:abc123def and events:9_xyz';
  const out = normalize(input);
  assert.strictEqual(out, 'fetched events:<ID> and events:<ID>');
});

test('normalize replaces pids', () => {
  const input = 'pid=12345 running; pid=9 idle';
  const out = normalize(input);
  assert.strictEqual(out, 'pid=<PID> running; pid=<PID> idle');
});

test('normalize replaces took_ms durations', () => {
  const input = '{ "took_ms": 47, "other": 12 }';
  const out = normalize(input);
  assert.strictEqual(out, '{ "took_ms": <MS>, "other": 12 }');
});

test('normalizeDoctorOutput strips dynamic header timestamp line', () => {
  const input = [
    'Robin doctor — 2026-05-17 13:42:01',
    '',
    'paths        ok        3 checks',
  ].join('\n');
  const out = normalizeDoctorOutput(input);
  assert.match(out, /Robin doctor — <TIMESTAMP>/);
});
