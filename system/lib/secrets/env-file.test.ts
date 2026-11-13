import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readEnvFile, removeEnvKey, writeEnvKey, writeSecretFile } from './env-file.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'robin-envfile-'));
const mode = (p: string) => statSync(p).mode & 0o777;

test('writeEnvKey: replaces in place, keeps comments', () => {
  const p = join(tmp(), '.env');
  writeFileSync(p, '# c\nA=1\nB=2\n');
  writeEnvKey(p, 'A', 'x');
  assert.equal(readFileSync(p, 'utf8'), '# c\nA=x\nB=2\n');
});

test('writeEnvKey: appends a new key', () => {
  const p = join(tmp(), '.env');
  writeFileSync(p, 'A=1\n');
  writeEnvKey(p, 'C', '3');
  assert.equal(readFileSync(p, 'utf8'), 'A=1\nC=3\n');
});

test('writeEnvKey: result is mode 0600 even if the file was 0644', () => {
  const p = join(tmp(), '.env');
  writeFileSync(p, 'A=1\n');
  chmodSync(p, 0o644);
  writeEnvKey(p, 'A', '2');
  assert.equal(mode(p), 0o600);
});

test('writeEnvKey: backup made, 0600, pruned to 5', () => {
  const dir = tmp();
  const p = join(dir, '.env');
  writeFileSync(p, 'A=0\n');
  const t0 = Date.UTC(2026, 10, 13, 12, 0, 0);
  for (let i = 1; i <= 7; i++) writeEnvKey(p, 'A', String(i), { now: new Date(t0 + i * 1000) });
  const baks = readdirSync(dir)
    .filter((f) => f.includes('.bak-'))
    .sort();
  assert.equal(baks.length, 5);
  for (const b of baks) assert.equal(mode(join(dir, b)), 0o600);
  // backups hold the prior content; the two oldest (A=0, A=1) are gone
  assert.equal(readFileSync(join(dir, baks[0]), 'utf8'), 'A=2\n');
  assert.equal(readFileSync(join(dir, baks[4]), 'utf8'), 'A=6\n');
});

test('writeEnvKey: backups:false makes none', () => {
  const dir = tmp();
  const p = join(dir, '.env');
  writeFileSync(p, 'A=1\n');
  writeEnvKey(p, 'A', '2', { backups: false });
  assert.deepEqual(readdirSync(dir), ['.env']);
});

test('writeEnvKey: no tmp file left behind', () => {
  const dir = tmp();
  const p = join(dir, '.env');
  writeEnvKey(p, 'A', '1');
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')));
});

test('writeEnvKey: value with space or = is double-quoted and parses back', () => {
  const p = join(tmp(), '.env');
  writeEnvKey(p, 'A', 'a b=c');
  assert.match(readFileSync(p, 'utf8'), /^A="a b=c"\n$/);
  assert.equal(readEnvFile(p).get('A'), 'a b=c');
});

test('writeEnvKey: $ in value is written literally', () => {
  const p = join(tmp(), '.env');
  writeFileSync(p, 'A=1\n');
  writeEnvKey(p, 'A', "x$&y$'z");
  assert.equal(readEnvFile(p).get('A'), "x$&y$'z");
});

test('readEnvFile: missing file gives empty map', () => {
  assert.equal(readEnvFile(join(tmp(), 'nope')).size, 0);
});

test('removeEnvKey: removes line, reports whether it existed', () => {
  const p = join(tmp(), '.env');
  writeFileSync(p, '# c\nA=1\nB=2\n');
  assert.equal(removeEnvKey(p, 'A'), true);
  assert.equal(readFileSync(p, 'utf8'), '# c\nB=2\n');
  assert.equal(removeEnvKey(p, 'A'), false);
  assert.equal(removeEnvKey(join(tmp(), 'nope'), 'A'), false);
});

test('writeSecretFile: writes value + newline, 0600', () => {
  const p = join(tmp(), 'secret');
  writeSecretFile(p, 'spk_test_abcdef0123456789');
  assert.equal(readFileSync(p, 'utf8'), 'spk_test_abcdef0123456789\n');
  assert.equal(mode(p), 0o600);
});
