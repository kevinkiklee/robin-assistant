import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { secretsPaths } from '../store.ts';
import { loadRedactionValues, REDACTED, redactOutput } from './redact-policy.ts';

const KEY = 'spk_test_0123456789abcdefXYZ';
const SHORT_KEY = 'spk_test_aaaaaaaaaaa'; // exactly 20 chars

test('redact: claude-in-chrome text block', () => {
  const out = [{ type: 'text', text: `textbox "${KEY}"` }];
  const r = redactOutput(out, [KEY]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.output, [{ type: 'text', text: `textbox "${REDACTED}"` }]);
  // input not mutated
  assert.equal(out[0].text, `textbox "${KEY}"`);
});

test('redact: Bash shape', () => {
  const r = redactOutput({ stdout: `X=${KEY}`, stderr: '', interrupted: false, isImage: false }, [
    KEY,
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.output, {
    stdout: `X=${REDACTED}`,
    stderr: '',
    interrupted: false,
    isImage: false,
  });
});

test('redact: plain string output', () => {
  const r = redactOutput(`a ${KEY} b ${KEY}`, [KEY]);
  assert.deepEqual(r, { changed: true, output: `a ${REDACTED} b ${REDACTED}` });
});

test('redact: nested objects and arrays at any depth', () => {
  const r = redactOutput({ a: [{ b: { c: [`${KEY}!`] } }], n: 3, z: null }, [KEY]);
  assert.deepEqual(r.output, { a: [{ b: { c: [`${REDACTED}!`] } }], n: 3, z: null });
});

test('redact: image block passes through untouched', () => {
  const img = { type: 'image', source: { type: 'base64', data: KEY } };
  const r = redactOutput([img, { type: 'text', text: KEY }], [KEY]);
  assert.equal(r.changed, true);
  const arr = r.output as unknown[];
  assert.equal(arr[0], img);
  assert.deepEqual(arr[1], { type: 'text', text: REDACTED });
});

test('redact: overlapping values replaced longest first', () => {
  const A = SHORT_KEY;
  assert.equal(A.length, 20);
  const url = `postgres://u:${A}@h/db`;
  const r = redactOutput(`conn=${url} raw=${A}`, [url, A]);
  const s = r.output as string;
  assert.equal(s, `conn=${REDACTED} raw=${REDACTED}`);
  for (let i = 0; i + 8 <= A.length; i++) assert.equal(s.includes(A.slice(i, i + 8)), false);
});

test('redact: partially overlapping matches leave no fragment of either value', () => {
  const X = 'spk_test_overlap_AAAABBBB';
  const Y = 'AAAABBBB_overlap_tail_000';
  const r = redactOutput(`>>spk_test_overlap_AAAABBBB_overlap_tail_000<<`, [X, Y]);
  assert.equal(r.output, `>>${REDACTED}<<`);
});

test('redact: JSON-escaped, URL-encoded, base64 and hex forms', () => {
  const V = 'spk_test_q"uote\\slash/plus+eq=';
  const json = JSON.stringify({ k: V });
  assert.equal(redactOutput(json, [V]).output, `{"k":"${REDACTED}"}`);
  const url = `https://x.test/?k=${encodeURIComponent(V)}&z=1`;
  assert.equal(redactOutput(url, [V]).output, `https://x.test/?k=${REDACTED}&z=1`);
  const form = new URLSearchParams({ k: V }).toString();
  assert.equal(redactOutput(form, [V]).output, `k=${REDACTED}`);
  const doubled = JSON.stringify({ body: json });
  assert.equal(redactOutput(doubled, [V]).output, `{"body":"{\\"k\\":\\"${REDACTED}\\"}"}`);
  const phpJson = `{"k":"${JSON.stringify(V).slice(1, -1).replace(/\//g, '\\/')}"}`;
  assert.equal(redactOutput(phpJson, [V]).output, `{"k":"${REDACTED}"}`);
  for (const prefix of ['', 'u', 'us', 'usr:']) {
    const b64 = Buffer.from(`${prefix}${KEY}`).toString('base64');
    const s = redactOutput(`Basic ${b64}`, [KEY]).output as string;
    assert.ok(s.includes(REDACTED), `base64 with ${prefix.length}-byte prefix`);
    const b64url = Buffer.from(`${prefix}${KEY}`).toString('base64url');
    assert.ok((redactOutput(b64url, [KEY]).output as string).includes(REDACTED));
  }
  const hex = Buffer.from(KEY).toString('hex');
  assert.equal(redactOutput(hex, [KEY]).output, REDACTED);
  assert.equal(redactOutput(hex.toUpperCase(), [KEY]).output, REDACTED);
});

test('redact: nothing to replace → changed false', () => {
  const out = [{ type: 'text', text: 'nothing here' }];
  const r = redactOutput(out, [KEY]);
  assert.equal(r.changed, false);
  assert.equal(r.output, out);
  assert.equal(redactOutput({ stdout: KEY }, []).changed, false);
  assert.equal(redactOutput(undefined, [KEY]).changed, false);
});

test('loadRedactionValues: vault values regardless of name; .env only secret-class; short values skipped; redact-files read', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-redact-'));
  const home = mkdtempSync(join(tmpdir(), 'robin-redact-home-'));
  const p = secretsPaths(u);
  mkdirSync(join(u, 'config', 'secrets'), { recursive: true });
  writeFileSync(
    p.vault,
    [
      'PLAIN_THING=spk_test_vault_plain_0001',
      'SHORTV=spk_test_s',
      'DUP_KEY=spk_test_dup_value_000001',
    ].join('\n'),
  );
  writeFileSync(
    p.robinEnv,
    [
      'API_TOKEN=spk_test_env_token_000001',
      'PLAIN_URL=spk_test_env_plain_00001',
      'SHORT_SECRET=spk_test_x',
      'OTHER_KEY=spk_test_dup_value_000001',
    ].join('\n'),
  );
  writeFileSync(
    p.daemonEnv,
    'DB_PASSWORD=spk_test_daemon_pw_0000001\nMODE=spk_test_daemon_mode_01\n',
  );
  const f1 = join(u, 'whole-file-secret');
  writeFileSync(f1, '  spk_test_file_value_00000001  \n');
  writeFileSync(join(home, 'tilde-secret'), 'spk_test_tilde_value_000001\n');
  writeFileSync(join(u, 'short-file'), 'spk_test_tiny\n');
  writeFileSync(
    p.redactFiles,
    [
      '# comment line',
      '',
      `  ${f1}  `,
      '~/tilde-secret',
      join(u, 'short-file'),
      join(u, 'missing-file'),
    ].join('\n'),
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  let values: string[];
  try {
    values = loadRedactionValues(u);
  } finally {
    process.env.HOME = prevHome;
  }
  assert.deepEqual(
    [...values].sort(),
    [
      'spk_test_vault_plain_0001',
      'spk_test_dup_value_000001',
      'spk_test_env_token_000001',
      'spk_test_daemon_pw_0000001',
      'spk_test_file_value_00000001',
      'spk_test_tilde_value_000001',
    ].sort(),
  );
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i - 1].length >= values[i].length, 'sorted by length descending');
  }
});

test('loadRedactionValues: no files → empty', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-redact-'));
  assert.deepEqual(loadRedactionValues(u), []);
});

test('loadRedactionValues: a directory listed in redact-files throws', () => {
  const u = mkdtempSync(join(tmpdir(), 'robin-redact-'));
  const p = secretsPaths(u);
  mkdirSync(join(u, 'config', 'secrets'), { recursive: true });
  writeFileSync(p.redactFiles, `${u}\n`);
  assert.throws(() => loadRedactionValues(u));
});
