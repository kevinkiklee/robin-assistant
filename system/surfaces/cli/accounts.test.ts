import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCredentials } from '../../agent/credentials/config.ts';
import { CredentialStateStore, statePath } from '../../agent/credentials/state.ts';
import { accountsUse, renderAccounts } from './accounts.ts';

const NOW = Date.UTC(2026, 10, 2, 12);
const DAY = 86_400_000;
const creds = loadCredentials({
  CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin',
  CLAUDE_TOKEN_SHARED: 'sk-ant-oat01-FAKE-shared',
});

test('renderAccounts: none configured', () => {
  const out = renderAccounts({
    credentials: [],
    state: { version: 1, credentials: {} },
    mode: 'auto',
    nowMs: NOW,
  });
  assert.equal(out, 'No Claude credentials configured — using the local claude login.');
});

test('renderAccounts: robin limited on sonnet, shared ok, never prints a secret', () => {
  const out = renderAccounts({
    credentials: creds,
    state: {
      version: 1,
      credentials: {
        'robin:subscription': {
          fingerprint: 'x',
          firstSeenAtMs: NOW - 100 * DAY,
          lastUsedAtMs: NOW - 60_000,
          limits: [
            { status: 'rejected', scope: 'sonnet', resetsAtMs: NOW + 3_600_000, observedAtMs: NOW },
          ],
        },
      },
    },
    mode: 'auto',
    nowMs: NOW,
  });
  const lines = out.split('\n');
  assert.equal(lines[0], 'Claude credentials (rotation: auto)');
  assert.match(lines[1], /robin \(subscription, [0-9a-f]{12}\)/);
  assert.match(lines[1], /all ok/);
  assert.match(lines[1], /sonnet limited until /);
  assert.match(lines[1], /expires in 265d/);
  assert.match(lines[1], /last used /);
  assert.match(lines[2], /shared \(subscription/);
  assert.match(lines[2], /not yet used/);
  assert.doesNotMatch(out, /FAKE/);
  assert.doesNotMatch(out, /pinned/);
});

test('renderAccounts: manual mode marks the pinned credential', () => {
  const out = renderAccounts({
    credentials: creds,
    state: { version: 1, pinned: 'shared', credentials: {} },
    mode: 'manual',
    nowMs: NOW,
  });
  const lines = out.split('\n');
  assert.equal(lines[0], 'Claude credentials (rotation: manual)');
  assert.doesNotMatch(lines[1], /pinned/);
  assert.match(lines[2], /pinned/);
});

test('accountsUse: rejects bogus and unconfigured names, pins configured ones', () => {
  const userData = mkdtempSync(join(tmpdir(), 'accts-'));
  try {
    const env = { CLAUDE_TOKEN_ROBIN: 'sk-ant-oat01-FAKE-robin' };
    const bogus = accountsUse({ userData, env, name: 'bogus' });
    assert.equal(bogus.code, 1);
    assert.match(bogus.message, /robin.*shared/);
    const unconfigured = accountsUse({ userData, env, name: 'shared' });
    assert.equal(unconfigured.code, 1);
    assert.match(unconfigured.message, /not configured/);
    const ok = accountsUse({ userData, env, name: 'robin' });
    assert.equal(ok.code, 0);
    assert.equal(
      ok.message,
      'Pinned robin. Takes effect in manual rotation (agent.account_rotation: manual).',
    );
    assert.equal(new CredentialStateStore(statePath(userData)).read().pinned, 'robin');
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
