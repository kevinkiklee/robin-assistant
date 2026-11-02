import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from '../../../agent/credentials/config.ts';
import { CredentialStateStore, statePath } from '../../../agent/credentials/state.ts';
import { loadEnvFile } from '../../../lib/secrets/load-env.ts';
import { credentialsExpiringInvariant } from './credentials-expiring.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2);
const ENV = { CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin' };

function withState(
  daysLeft: number | null,
  fn: (userData: string) => Promise<void>,
  fp = fingerprint(ENV.CLAUDE_TOKEN_ROBIN),
) {
  const userData = mkdtempSync(join(tmpdir(), 'cred-exp-'));
  if (daysLeft !== null) {
    new CredentialStateStore(statePath(userData)).update((s) => {
      s.credentials['robin:subscription'] = {
        fingerprint: fp,
        firstSeenAtMs: NOW - (365 - daysLeft) * DAY,
        limits: [],
      };
    });
  }
  return fn(userData).finally(() => rmSync(userData, { recursive: true, force: true }));
}

test('agent.credentials_expiring: ok with 40 days left', () =>
  withState(40, async (userData) => {
    const inv = credentialsExpiringInvariant({ userData, env: ENV, nowMs: () => NOW });
    assert.equal(inv.name, 'agent.credentials_expiring');
    assert.equal(inv.severity, 'warning');
    assert.equal((await inv.check()).ok, true);
  }));

test('agent.credentials_expiring: fails with 20 days left, names the credential, no secret', () =>
  withState(20, async (userData) => {
    const inv = credentialsExpiringInvariant({ userData, env: ENV, nowMs: () => NOW });
    const r = await inv.check();
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /robin \(subscription, [0-9a-f]{12}\)/);
    assert.doesNotMatch(r.message ?? '', /FAKE/);
    assert.match(inv.fix, /claude setup-token/);
  }));

test('agent.credentials_expiring: ok when never used or nothing configured', () =>
  withState(null, async (userData) => {
    assert.equal(
      (await credentialsExpiringInvariant({ userData, env: ENV, nowMs: () => NOW }).check()).ok,
      true,
    );
    assert.equal(
      (await credentialsExpiringInvariant({ userData, env: {}, nowMs: () => NOW }).check()).ok,
      true,
    );
  }));

test('agent.credentials_expiring: shared without robin fails with the pause message', () =>
  withState(null, async (userData) => {
    const inv = credentialsExpiringInvariant({
      userData,
      env: { CLAUDE_TOKEN_SHARED: 'sk-ant-oat01-FAKE-shared' },
      nowMs: () => NOW,
    });
    const r = await inv.check();
    assert.equal(r.ok, false);
    assert.equal(
      r.message,
      'CLAUDE_TOKEN_SHARED is set without CLAUDE_TOKEN_ROBIN — background work is paused (it never borrows your account without a Robin credential)',
    );
  }));

test('agent.credentials_expiring: sees a token that lives only in daemon.env', () =>
  withState(null, async (userData) => {
    mkdirSync(join(userData, 'config', 'secrets'), { recursive: true });
    writeFileSync(
      join(userData, 'config', 'secrets', 'daemon.env'),
      'CLAUDE_TOKEN_SHARED=sk-ant-oat01-FAKE-shared\n',
    );
    const env: Record<string, string | undefined> = {};
    loadEnvFile(userData, env);
    const r = await credentialsExpiringInvariant({ userData, env, nowMs: () => NOW }).check();
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /without CLAUDE_TOKEN_ROBIN/);
  }));

test("agent.credentials_expiring: a renewed token ignores the old fingerprint's age", () =>
  withState(
    20,
    async (userData) => {
      const r = await credentialsExpiringInvariant({
        userData,
        env: ENV,
        nowMs: () => NOW,
      }).check();
      assert.equal(r.ok, true);
    },
    fingerprint('sk-ant-oat01-FAKE-old'),
  ));
