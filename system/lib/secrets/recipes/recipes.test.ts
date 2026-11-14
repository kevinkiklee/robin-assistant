import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { anthropic } from './anthropic.ts';
import { cloudflare } from './cloudflare.ts';
import { ebird } from './ebird.ts';
import { buildInspectScript, buildLocateScript, scriptHashes } from './generic.ts';
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
  assert.equal(scriptHashes(linear).length, 3); // locateReveal, locateCopy, inspectReveal
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
  title?: string;
  scrolled?: unknown;
}
function runScript(script: string, els: StubEl[]): unknown {
  const cache = new Map<StubEl, unknown>();
  const wrap = (e: StubEl) => {
    if (!cache.has(e)) {
      cache.set(e, {
        ...(e.value !== undefined ? { value: e.value } : {}),
        textContent: e.text ?? '',
        tagName: e.tag.toUpperCase(),
        childNodes: e.text ? [{ nodeType: 3, textContent: e.text }] : [],
        getAttribute: (n: string) =>
          n === 'aria-label' ? (e.aria ?? null) : n === 'title' ? (e.title ?? null) : null,
        getBoundingClientRect: () => e.rect,
        getRootNode: () => ({}),
        scrollIntoView: (o: unknown) => {
          e.scrolled = o;
        },
      });
    }
    return cache.get(e);
  };
  const pick = (sel: string) =>
    sel === '*'
      ? els.map(wrap)
      : els.filter((e) => sel.split(',').some((s) => s.trim() === e.tag)).map(wrap);
  const body = { contains: () => true };
  const ctx = {
    document: { querySelectorAll: pick, body },
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

test('locate script: key in a plain div, icon Copy button labelled by aria-label', () => {
  const script = buildLocateScript({
    buttonText: /copy/i,
    nearValueShape: /^[A-Za-z0-9_-]{40,64}$/,
  });
  const els: StubEl[] = [
    {
      tag: 'div',
      rect: { left: 0, top: 50, width: 300, height: 20 },
      text: 'spk_test_FAKEcloudflare0123456789abcdefghijkl',
    },
    {
      tag: 'button',
      rect: { left: 310, top: 50, width: 20, height: 20 },
      aria: 'Copy to clipboard',
    },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(runScript(script, els))), {
    found: true,
    x: 320,
    y: 60,
  });
});

test('locate script: title attribute counts as a Copy label', () => {
  const script = buildLocateScript({ buttonText: /copy/i, nearValueShape: /^lin_api_\w+$/ });
  const els: StubEl[] = [
    { tag: 'span', rect: { left: 0, top: 0, width: 100, height: 20 }, text: 'lin_api_FAKE123456' },
    { tag: 'button', rect: { left: 110, top: 0, width: 20, height: 20 }, title: 'Copy' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(runScript(script, els))), {
    found: true,
    x: 120,
    y: 10,
  });
});

test('inspect script: structure only — never the key, never page text', () => {
  const fake = 'spk_test_FAKEcloudflare0123456789abcdefghijkl';
  const script = buildInspectScript(/^[A-Za-z0-9_-]{40,64}$/);
  const els: StubEl[] = [
    { tag: 'div', rect: { left: 0, top: 50, width: 300, height: 20 }, text: fake },
    {
      tag: 'span',
      rect: { left: 0, top: 80, width: 300, height: 20 },
      text: 'Keep it somewhere safe 42',
    },
    {
      tag: 'button',
      rect: { left: 310, top: 50, width: 20, height: 20 },
      aria: 'Copy to clipboard',
    },
  ];
  const r = JSON.parse(JSON.stringify(runScript(script, els)));
  const out = JSON.stringify(r);
  assert.equal(r.anyShape, true);
  assert.ok(!out.includes(fake), 'key leaked');
  assert.ok(!out.includes('FAKEcloud'), 'key fragment leaked');
  assert.ok(!out.includes('somewhere'), 'page text leaked');
  const btn = r.els.find((e: { tag: string }) => e.tag === 'button');
  assert.equal(btn.label, 'Copy to clipboard');
  const div = r.els.find((e: { tag: string }) => e.tag === 'div');
  assert.equal(div.ownShape, true);
  assert.equal(div.ownLen, fake.length);
});

test('inspect script: a label that is not letters-only is withheld', () => {
  const script = buildInspectScript(/^[A-Za-z0-9_-]{40,64}$/);
  const els: StubEl[] = [
    {
      tag: 'button',
      rect: { left: 0, top: 0, width: 20, height: 20 },
      aria: 'copy spk_test_FAKE123',
    },
  ];
  const r = JSON.parse(JSON.stringify(runScript(script, els)));
  assert.equal(r.els[0].label, '<other>');
});

test('inspect script: a letters-only label that has the key shape is withheld', () => {
  const script = buildInspectScript(/^[A-Za-z]{10,}$/);
  const els: StubEl[] = [
    { tag: 'button', rect: { left: 0, top: 0, width: 20, height: 20 }, aria: 'abcdefghijkl' },
    { tag: 'button', rect: { left: 30, top: 0, width: 20, height: 20 }, aria: 'Copy key' },
  ];
  const r = JSON.parse(JSON.stringify(runScript(script, els)));
  assert.equal(r.els[0].label, '<other>');
  assert.equal(r.els[1].label, 'Copy key', 'no token of "Copy key" has the key shape');
});

test('cloudflare locateCopy: masked token — anchors on Reveal, picks Copy to clipboard, not the curl Copy', () => {
  // Layout recorded from the live roll dialog on 2026-11-13 (structure only).
  const els: StubEl[] = [
    { tag: 'span', rect: { left: 636, top: 374, width: 450, height: 15 }, text: '••••••••' },
    { tag: 'button', rect: { left: 1086, top: 362, width: 39, height: 40 }, aria: 'Reveal value' },
    {
      tag: 'button',
      rect: { left: 1125, top: 362, width: 39, height: 40 },
      aria: 'Copy to clipboard',
    },
    { tag: 'button', rect: { left: 1109, top: 473, width: 46, height: 26 }, text: 'Copy' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(runScript(cloudflare.locateCopy as string, els))), {
    found: true,
    x: 1145,
    y: 382,
  });
});

test('anchor fallback is off unless the recipe asks for it', () => {
  const els: StubEl[] = [
    { tag: 'button', rect: { left: 0, top: 0, width: 20, height: 20 }, aria: 'Reveal value' },
    { tag: 'button', rect: { left: 30, top: 0, width: 20, height: 20 }, aria: 'Copy to clipboard' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(runScript(linear.locateCopy as string, els))), {
    found: false,
  });
});

test('inspect script skips icon sprites and hidden elements', () => {
  const script = buildInspectScript(/^lin_api_\w+$/);
  const els: StubEl[] = [
    { tag: 'svg', rect: { left: 0, top: 0, width: 0, height: 0 } },
    { tag: 'path', rect: { left: 0, top: 0, width: 0, height: 0 } },
    { tag: 'div', rect: { left: 0, top: 0, width: 0, height: 0 }, text: 'hidden' },
    { tag: 'button', rect: { left: 10, top: 10, width: 20, height: 20 }, aria: 'Copy' },
  ];
  const r = JSON.parse(JSON.stringify(runScript(script, els)));
  assert.deepEqual(
    r.els.map((e: { tag: string }) => e.tag),
    ['button'],
  );
});

test('inspect script is hash-allowlisted with the recipe', () => {
  assert.ok(cloudflare.inspectReveal);
  assert.equal(scriptHashes(cloudflare).length, 3);
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
