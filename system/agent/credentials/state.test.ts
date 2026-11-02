import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStateStore, scopeOf, statePath } from './state.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'robin-cred-'));
}

test('state: missing file reads empty', () => {
  const s = new CredentialStateStore(join(tmp(), 'x.json'));
  assert.deepEqual(s.read(), { version: 1, credentials: {} });
});

test('state: corrupt or wrong-version file reads empty, no throw', () => {
  const dir = tmp();
  const p = join(dir, 'x.json');
  writeFileSync(p, '{"vers');
  assert.deepEqual(new CredentialStateStore(p).read(), { version: 1, credentials: {} });
  writeFileSync(p, '{"version":2,"credentials":{"a":{}}}');
  assert.deepEqual(new CredentialStateStore(p).read(), { version: 1, credentials: {} });
});

test('state: update round-trips atomically, creates parent dir', () => {
  const dir = tmp();
  const p = join(dir, 'a', 'b', 'x.json');
  const s = new CredentialStateStore(p, () => 5);
  const out = s.update((st) => {
    st.pinned = 'robin';
    st.credentials['robin:subscription'] = {
      fingerprint: 'abc',
      firstSeenAtMs: 5,
      limits: [{ status: 'rejected', scope: 'all', observedAtMs: 5 }],
    };
  });
  assert.equal(out.pinned, 'robin');
  assert.deepEqual(new CredentialStateStore(p).read(), out);
  assert.deepEqual(
    readdirSync(join(dir, 'a', 'b')).filter((f) => f.includes('.tmp-')),
    [],
  );
});

test('state: statePath', () => {
  assert.equal(statePath('/u'), '/u/state/runtime/claude-credentials.json');
});

test('state: scopeOf', () => {
  assert.equal(scopeOf('seven_day_opus'), 'opus');
  assert.equal(scopeOf('seven_day_sonnet'), 'sonnet');
  assert.equal(scopeOf('five_hour'), 'all');
  assert.equal(scopeOf(undefined), 'all');
});
