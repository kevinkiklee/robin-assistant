import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest } from './manifest.ts';
import { toPublicSlug } from './slug.ts';
import type { LogRow } from './types.ts';

const row = (o: Partial<LogRow>): LogRow => ({
  ts: '2026-05-01T00:00:00.000Z',
  action: 'overwrite',
  slug: 's',
  url: 'x',
  user_id: 'quinn',
  source: null,
  blob_key: 'k',
  title: 'T',
  assets: [],
  warnings: [],
  ...o,
});

const ENV = { publicUrl: 'https://askrobin.io', userId: 'quinn', urlSecret: 'test-secret' };

const hashed = (slug: string): string => toPublicSlug(ENV.userId, slug, ENV.urlSecret);

test('buildManifest: title from latest, published=earliest, updated=latest, url hashed', () => {
  const entries: LogRow[] = [
    row({ slug: 'a', ts: '2026-05-01T00:00:00.000Z', title: 'Old', url: 'https://x/p/a' }),
    row({ slug: 'a', ts: '2026-05-03T00:00:00.000Z', title: 'New', url: 'https://x/p/a' }),
  ];
  const m = buildManifest(entries, ENV);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], {
    slug: 'a',
    title: 'New',
    url: `https://askrobin.io/@quinn/${hashed('a')}`,
    published_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-03T00:00:00.000Z',
    category: 'Uncategorized',
    description: null,
  });
  // The hash must actually be there — url must not be the bare slug.
  assert.notEqual(m[0].url, 'https://askrobin.io/@quinn/a');
  assert.match(m[0].url, /\/@quinn\/a-[0-9a-f]{10}$/);
});

test('buildManifest: drops slugs whose latest action is delete', () => {
  const entries: LogRow[] = [
    row({ slug: 'b', ts: '2026-05-01T00:00:00.000Z', action: 'overwrite' }),
    row({ slug: 'b', ts: '2026-05-02T00:00:00.000Z', action: 'delete' }),
  ];
  assert.equal(buildManifest(entries, ENV).length, 0);
});

test('buildManifest: re-published after delete is included', () => {
  const entries: LogRow[] = [
    row({ slug: 'c', ts: '2026-05-01T00:00:00.000Z', action: 'overwrite' }),
    row({ slug: 'c', ts: '2026-05-02T00:00:00.000Z', action: 'delete' }),
    row({ slug: 'c', ts: '2026-05-03T00:00:00.000Z', action: 'overwrite', title: 'Back' }),
  ];
  const m = buildManifest(entries, ENV);
  assert.equal(m.length, 1);
  assert.equal(m[0].title, 'Back');
});

test('buildManifest: sorted newest-first by updated_at; empty input → []', () => {
  assert.deepEqual(buildManifest([], ENV), []);
  const m = buildManifest(
    [
      row({ slug: 'old', ts: '2026-05-01T00:00:00.000Z' }),
      row({ slug: 'new', ts: '2026-05-09T00:00:00.000Z' }),
    ],
    ENV,
  );
  assert.deepEqual(
    m.map((e) => e.slug),
    ['new', 'old'],
  );
});

test('buildManifest carries category/description from latest row; legacy rows default safely', () => {
  const rows = [
    row({
      slug: 'a',
      ts: '2026-01-01T00:00:00Z',
      action: 'append',
      category: 'Essays',
      description: 'd1',
    }),
    row({
      slug: 'a',
      ts: '2026-02-01T00:00:00Z',
      action: 'overwrite',
      category: 'Field Guides',
      description: 'd2',
    }),
    row({ slug: 'b', ts: '2026-01-01T00:00:00Z', action: 'append' }),
  ];
  const m = buildManifest(rows, ENV);
  const a = m.find((e) => e.slug === 'a');
  const b = m.find((e) => e.slug === 'b');
  assert.equal(a?.category, 'Field Guides');
  assert.equal(a?.description, 'd2');
  assert.equal(b?.category, 'Uncategorized');
  assert.equal(b?.description, null);
});

test('buildManifest: recategorize row changes category only — no updated_at bump', () => {
  const entries: LogRow[] = [
    row({
      slug: 'r',
      ts: '2026-05-01T00:00:00.000Z',
      title: 'Real Title',
      description: 'real desc',
      category: 'Essays',
    }),
    row({
      slug: 'r',
      ts: '2026-06-01T00:00:00.000Z',
      action: 'recategorize',
      title: 'Real Title',
      description: 'real desc',
      category: 'Critiques',
    }),
  ];
  const m = buildManifest(entries, ENV);
  assert.equal(m.length, 1);
  assert.equal(m[0].category, 'Critiques');
  assert.equal(m[0].updated_at, '2026-05-01T00:00:00.000Z'); // NOT bumped
  assert.equal(m[0].title, 'Real Title');
});

test('buildManifest: recategorize never resurrects a deleted slug', () => {
  const entries: LogRow[] = [
    row({ slug: 'd', ts: '2026-05-01T00:00:00.000Z' }),
    row({ slug: 'd', ts: '2026-05-02T00:00:00.000Z', action: 'delete' }),
    row({ slug: 'd', ts: '2026-05-03T00:00:00.000Z', action: 'recategorize', category: 'Essays' }),
  ];
  assert.equal(buildManifest(entries, ENV).length, 0);
});

test('buildManifest: a later republish overrides an earlier recategorize', () => {
  const entries: LogRow[] = [
    row({ slug: 'o', ts: '2026-05-01T00:00:00.000Z', category: 'Essays' }),
    row({
      slug: 'o',
      ts: '2026-05-02T00:00:00.000Z',
      action: 'recategorize',
      category: 'Critiques',
    }),
    row({ slug: 'o', ts: '2026-05-03T00:00:00.000Z', category: 'Projects', title: 'Newer' }),
  ];
  const m = buildManifest(entries, ENV);
  assert.equal(m[0].category, 'Projects');
  assert.equal(m[0].updated_at, '2026-05-03T00:00:00.000Z');
});
