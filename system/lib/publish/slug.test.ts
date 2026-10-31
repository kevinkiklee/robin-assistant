import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendSuffix,
  deriveSlug,
  hashPageSlug,
  isRefusedSlug,
  sanitizeSlug,
  toPublicSlug,
} from './slug.ts';

test('sanitizeSlug: lowercases, collapses non-alnum, trims', () => {
  assert.equal(sanitizeSlug('Hello World!'), 'hello-world');
  assert.equal(sanitizeSlug('  --foo--bar--  '), 'foo-bar');
  assert.equal(sanitizeSlug('UPPER_case 123'), 'upper-case-123');
});

test('sanitizeSlug: rejects reserved prefix and empty input', () => {
  assert.equal(sanitizeSlug('_internal'), '');
  assert.equal(sanitizeSlug(''), '');
  assert.equal(sanitizeSlug(null), '');
  assert.equal(sanitizeSlug(undefined), '');
});

test('sanitizeSlug: enforces max length without trailing dash', () => {
  const long = 'a'.repeat(120);
  const out = sanitizeSlug(long);
  assert.ok(out.length <= 80, `expected ≤ 80, got ${out.length}`);
  assert.ok(!out.endsWith('-'));
});

test('deriveSlug: prefers explicit user-specified', () => {
  const r = deriveSlug({
    explicit: 'my-slug',
    source: '/tmp/x.md',
    body: '# Heading',
    frontmatter: { slug: 'fm-slug', title: 'Some Title' },
  });
  assert.equal(r.slug, 'my-slug');
  assert.equal(r.origin, 'user-specified');
});

test('deriveSlug: falls back to frontmatter title, then source filename, then H1', () => {
  const fromTitle = deriveSlug({
    explicit: null,
    source: null,
    body: '',
    frontmatter: { title: 'My Doc Title' },
  });
  assert.equal(fromTitle.slug, 'my-doc-title');

  const fromFile = deriveSlug({
    explicit: null,
    source: '/tmp/foo-bar.md',
    body: '',
    frontmatter: {},
  });
  assert.equal(fromFile.slug, 'foo-bar');

  const fromH1 = deriveSlug({
    explicit: null,
    source: null,
    body: '# Sole H1\n\nsome text',
    frontmatter: {},
  });
  assert.equal(fromH1.slug, 'sole-h1');
});

test('deriveSlug: ultimate fallback is "page"', () => {
  const r = deriveSlug({ explicit: null, source: null, body: '', frontmatter: {} });
  assert.equal(r.slug, 'page');
});

test('isRefusedSlug: refuses the daily brief (bare and dated), allows everything else', () => {
  assert.equal(isRefusedSlug('daily-brief'), true);
  assert.equal(isRefusedSlug('daily-brief-2026-05-30'), true);
  assert.equal(isRefusedSlug('daily-brief-anything'), true);
  // Unrelated content that merely mentions "brief" is allowed.
  assert.equal(isRefusedSlug('my-daily-brief-system'), false);
  assert.equal(isRefusedSlug('briefing-notes'), false);
  assert.equal(isRefusedSlug('critique-2026-05-30'), false);
  assert.equal(isRefusedSlug('harbortown-field-notes'), false);
});

test('appendSuffix: appends a 7-char (- + 6) suffix and respects max length', () => {
  const out = appendSuffix('hello');
  assert.match(out, /^hello-[a-z0-9]{6}$/);
  const long = appendSuffix('a'.repeat(80));
  assert.ok(long.length <= 80);
  assert.match(long, /-[a-z0-9]{6}$/);
});

test('hashPageSlug: deterministic, 10 hex chars, keyed by secret and user', () => {
  const h = hashPageSlug('quinn', 'my-page', 'secret-1');
  assert.match(h, /^[0-9a-f]{10}$/);
  assert.equal(h, hashPageSlug('quinn', 'my-page', 'secret-1'));
  assert.notEqual(h, hashPageSlug('quinn', 'my-page', 'secret-2'));
  assert.notEqual(h, hashPageSlug('other', 'my-page', 'secret-1'));
  assert.notEqual(h, hashPageSlug('quinn', 'other-page', 'secret-1'));
});

test('toPublicSlug: appends the hash and is idempotent', () => {
  const pub = toPublicSlug('quinn', 'my-page', 's3cret');
  assert.equal(pub, `my-page-${hashPageSlug('quinn', 'my-page', 's3cret')}`);
  // Feeding a hashed slug back through must not double-hash.
  assert.equal(toPublicSlug('quinn', pub, 's3cret'), pub);
});

test('toPublicSlug: a lookalike suffix that fails HMAC verification is treated as content', () => {
  // 10 hex chars, but not the real hash of the prefix — must be hashed as-is.
  const fake = 'my-page-0123456789';
  const out = toPublicSlug('quinn', fake, 's3cret');
  assert.equal(out, `${fake}-${hashPageSlug('quinn', fake, 's3cret')}`);
});
