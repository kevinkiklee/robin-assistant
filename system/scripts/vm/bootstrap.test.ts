import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const hasBash = spawnSync('bash', ['--version']).status === 0;
const skip = hasBash ? false : 'bash unavailable';

test('bootstrap.sh passes bash -n', { skip }, () => {
  const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('bootstrap.sh --dry-run prints actions and invokes no stubbed command', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-bootstrap-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const calledLog = join(dir, 'called');
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    for (const name of ['sudo', 'apt-get', 'claude', 'cloudflared']) {
      stub(name, `echo "${name} $*" >> "${calledLog}"; exit 99`);
    }
    stub('node', 'echo v24.1.0');
    const home = join(dir, 'home');
    mkdirSync(home);
    const r = spawnSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, USER: 'robin' },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[dry-run\] sudo timedatectl set-timezone America\/Chicago/);
    assert.match(r.stdout, /\[dry-run\] sudo loginctl enable-linger/);
    const step10 = r.stdout.split('\n').find((l) => l.includes('daemon install')) ?? '';
    assert.ok(step10.includes('ROBIN_USER_DATA_DIR='), step10);
    assert.ok(step10.includes('/user-data'), step10);
    assert.match(r.stdout, /\[dry-run\] install -d -m 0700 .*secrets/);
    assert.equal(existsSync(calledLog), false, existsSync(calledLog) ? 'stub invoked' : '');
    assert.deepEqual(readdirSync(home), [], 'dry-run must not write to HOME');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
