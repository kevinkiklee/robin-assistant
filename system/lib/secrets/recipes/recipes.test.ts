import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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
  const unfinished = [cloudflare, linear, anthropic, ebird].filter((r) =>
    r.steps.some((s) => s.includes('FILL IN')),
  );
  assert.ok(unfinished.length > 0, 'test needs at least one unfinished recipe');
  const listed = listRecipes().map((r) => r.provider);
  for (const r of unfinished)
    assert.ok(!listed.includes(r.provider), `${r.provider} is unfinished`);
  assert.ok(listed.includes('google'));
  assert.ok(listed.includes('cloudflare'), 'cloudflare steps are filled');
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

interface StubEl {
  tag: string;
  rect: { left: number; top: number; width: number; height: number };
  text?: string;
  value?: string;
  aria?: string;
  scrolled?: unknown;
}
function runScript(script: string, els: StubEl[]): unknown {
  const wrap = (e: StubEl) => ({
    value: e.value,
    textContent: e.text ?? '',
    getAttribute: (n: string) => (n === 'aria-label' ? (e.aria ?? null) : null),
    getBoundingClientRect: () => e.rect,
    scrollIntoView: (o: unknown) => {
      e.scrolled = o;
    },
  });
  const pick = (sel: string) =>
    els.filter((e) => sel.split(',').some((s) => s.trim() === e.tag)).map(wrap);
  const ctx = {
    document: { querySelectorAll: pick },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  };
  return vm.runInNewContext(script, ctx);
}

test('locate script executes: near Copy button centre, ignores far Copy ID', () => {
  const script = buildLocateScript({ buttonText: /copy/i, nearValueShape: /^lin_api_\w+$/ });
  const els: StubEl[] = [
    {
      tag: 'pre',
      rect: { left: 10, top: 100, width: 200, height: 20 },
      text: 'KEY=lin_api_FAKE123456',
    },
    { tag: 'button', rect: { left: 220, top: 100, width: 40, height: 20 }, text: 'Copy' },
    { tag: 'button', rect: { left: 10, top: 2000, width: 60, height: 20 }, text: 'Copy ID' },
  ];
  const r = JSON.parse(JSON.stringify(runScript(script, els)));
  assert.deepEqual(r, { found: true, x: 240, y: 110 });
  assert.deepEqual(JSON.parse(JSON.stringify(els[1].scrolled)), {
    block: 'center',
    behavior: 'instant',
  });
  assert.equal(els[2].scrolled, undefined);
});

test('locate script: {found:false} when no key-shaped holder', () => {
  const script = buildLocateScript({ buttonText: /copy/i, nearValueShape: /^lin_api_\w+$/ });
  const els: StubEl[] = [
    { tag: 'input', rect: { left: 0, top: 0, width: 100, height: 20 }, value: 'hello' },
    { tag: 'button', rect: { left: 110, top: 0, width: 40, height: 20 }, text: 'Copy ID' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(runScript(script, els))), { found: false });
});

test('locate script text splits on whitespace, = and : (escaped in the template)', () => {
  const s = buildLocateScript({ buttonText: /copy/i, nearValueShape: /^lin_api_\w+$/ });
  assert.ok(s.includes('[\\s=:]'));
  assert.ok(!s.includes('[s=:]'));
});

test('locate script: space-separated holder and key containing the letter s', () => {
  const script = buildLocateScript({ buttonText: /copy/i, nearValueShape: /^lin_api_\w+$/ });
  for (const text of ['Your key lin_api_FAKE123456', 'lin_api_FAKEssss123s']) {
    const els: StubEl[] = [
      { tag: 'code', rect: { left: 0, top: 0, width: 100, height: 20 }, text },
      { tag: 'button', rect: { left: 110, top: 0, width: 40, height: 20 }, text: 'Copy' },
    ];
    assert.deepEqual(JSON.parse(JSON.stringify(runScript(script, els))), {
      found: true,
      x: 130,
      y: 10,
    });
  }
});
