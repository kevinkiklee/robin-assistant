import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { anthropic } from './anthropic.ts';
import { cloudflare } from './cloudflare.ts';
import { ebird } from './ebird.ts';
import { buildLocateScript, scriptHashes } from './generic.ts';
import { google, googleIntegrationFor } from './google.ts';
import { listRecipes } from './index.ts';
import { linear } from './linear.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fakeKey = (name: string): string => {
  const html = readFileSync(join(here, 'fixtures', `${name}.html`), 'utf8');
  const m = html.match(/data-fake-key="([^"]+)"/);
  assert.ok(m, `fixture ${name} lacks data-fake-key`);
  return m[1];
};

test('buildLocateScript: script text never references innerText/value in its return', () => {
  const s = buildLocateScript({ buttonText: /copy/i, nearValueShape: /^x+$/ });
  const returns = s.match(/return\s*[^;]*;/g) ?? [];
  assert.ok(returns.length > 0);
  for (const r of returns) {
    assert.doesNotMatch(r, /innerText|textContent|value/);
    const keys = [...r.matchAll(/(\w+)\s*:/g)].map((k) => k[1]);
    for (const k of keys) assert.ok(['found', 'x', 'y'].includes(k), `unexpected key ${k}`);
  }
  assert.doesNotMatch(s, /clipboard|Date\.now|Math\.random/);
});

test('scriptHashes: stable across calls', () => {
  assert.deepEqual(scriptHashes(linear), scriptHashes(linear));
  assert.equal(scriptHashes(linear).length, 2);
  assert.match(scriptHashes(linear)[0], /^[0-9a-f]{64}$/);
});

test("every recipe: shape matches its fixture's fake key and rejects 'not a key'", () => {
  for (const r of [cloudflare, linear, anthropic, ebird]) {
    const k = fakeKey(r.provider);
    assert.match(k, /FAKE/i);
    assert.doesNotMatch(k, /AA$/);
    assert.ok(r.shape.test(k), `${r.provider} shape should match fixture key`);
    assert.ok(!r.shape.test('not a key'), `${r.provider} shape should reject`);
  }
});

test('listRecipes: hides recipes still marked FILL IN', () => {
  assert.ok(
    [cloudflare, linear, anthropic, ebird].every((r) => r.steps.some((s) => s.includes('FILL IN'))),
  );
  assert.deepEqual(
    listRecipes().map((r) => r.provider),
    ['google'],
  );
});

test('defaults', () => {
  assert.deepEqual(cloudflare.target, { kind: 'secret-file', path: '~/.cloudflare/token' });
  assert.equal(cloudflare.rotate, 'roll');
  assert.equal(linear.rotate, 'create-revoke');
  assert.deepEqual(ebird.modes, ['get']);
});

test('google recipe: oauth, no scripts, integration from NAME prefix', () => {
  assert.equal(google.rotate, 'oauth');
  assert.deepEqual(scriptHashes(google), []);
  assert.equal(google.locateCopy, undefined);
  assert.equal(googleIntegrationFor('GMAIL_REFRESH_TOKEN'), 'gmail');
  assert.equal(googleIntegrationFor('GOOGLE_CALENDAR_REFRESH_TOKEN'), 'google_calendar');
  assert.equal(googleIntegrationFor('OTHER'), undefined);
});
