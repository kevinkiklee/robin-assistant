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
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        USER: 'robin',
        ROBIN_TZ: '',
        ROBIN_HOME: join(home, 'robin-assistant-v3'),
      },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(
      r.stdout,
      /timezone: unchanged/,
      'no ROBIN_TZ and no operator.yaml → host zone kept',
    );
    assert.match(r.stdout, /\[dry-run\] sudo loginctl enable-linger/);
    const step10 = r.stdout.split('\n').find((l) => l.includes('daemon install')) ?? '';
    assert.ok(step10.includes('ROBIN_USER_DATA_DIR='), step10);
    assert.ok(step10.includes('/user-data'), step10);
    assert.match(r.stdout, /\[dry-run\] install -d -m 0700 .*secrets/);
    for (const line of [
      "# Robin's Claude credentials — daemon-only. Never export these in a shell.",
      "# CLAUDE_TOKEN_ROBIN=        # account 2 (Robin's default) — claude setup-token",
      "# CLAUDE_TOKEN_SHARED=       # account 1 (your interactive account; borrowed when Robin's is limited)",
      '# CLAUDE_CREDIT_KEY_ROBIN=   # API key, Console org linked to account 2 (no auto-reload)',
      '# CLAUDE_CREDIT_KEY_SHARED=  # API key, Console org linked to account 1 (no auto-reload)',
    ]) {
      assert.ok(r.stdout.split('\n').includes(line), `missing template line: ${line}`);
    }
    assert.doesNotMatch(r.stdout, /OAUTH_TOKEN_[AB]/);
    assert.equal(existsSync(calledLog), false, existsSync(calledLog) ? 'stub invoked' : '');
    assert.deepEqual(readdirSync(home), [], 'dry-run must not write to HOME');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap.sh --dry-run takes the zone from ROBIN_TZ, then operator.yaml', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-bootstrap-tz-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const name of ['sudo', 'apt-get', 'claude', 'cloudflared']) {
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 99\n');
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v24.1.0\n');
    chmodSync(join(bin, 'node'), 0o755);
    const home = join(dir, 'home');
    const checkout = join(dir, 'checkout');
    mkdirSync(home);
    mkdirSync(join(checkout, 'user-data', 'config'), { recursive: true });
    writeFileSync(
      join(checkout, 'user-data', 'config', 'operator.yaml'),
      'name: Sam\ntimezone: "Pacific/Auckland"   # brief + audit\n',
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      USER: 'robin',
      ROBIN_HOME: checkout,
    };
    delete (env as Record<string, string | undefined>).ROBIN_TZ;
    const fromYaml = spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env });
    assert.equal(fromYaml.status, 0, fromYaml.stdout + fromYaml.stderr);
    assert.match(fromYaml.stdout, /\[dry-run\] sudo timedatectl set-timezone Pacific\/Auckland\n/);
    const fromEnv = spawnSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...env, ROBIN_TZ: 'Africa/Nairobi' },
    });
    assert.equal(fromEnv.status, 0, fromEnv.stdout + fromEnv.stderr);
    assert.match(fromEnv.stdout, /\[dry-run\] sudo timedatectl set-timezone Africa\/Nairobi\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
