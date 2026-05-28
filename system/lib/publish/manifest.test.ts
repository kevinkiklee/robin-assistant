import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest, writeManifest } from './manifest.ts';
import type { LogRow } from './types.ts';

const row = (o: Partial<LogRow>): LogRow => ({
  ts: '2026-05-01T00:00:00.000Z',
  action: 'overwrite',
  slug: 's',
  url: 'x',
  user_id: 'iser',
  source: null,
  blob_key: 'k',
  title: 'T',
  assets: [],
  warnings: [],
  ...o,
});

const ENV = { publicUrl: 'https://askrobin.io', userId: 'iser' };

test('buildManifest: title from latest, published=earliest, updated=latest, url recomputed', () => {
  const entries: LogRow[] = [
    row({ slug: 'a', ts: '2026-05-01T00:00:00.000Z', title: 'Old', url: 'https://x/p/a' }),
    row({ slug: 'a', ts: '2026-05-03T00:00:00.000Z', title: 'New', url: 'https://x/p/a' }),
  ];
  const m = buildManifest(entries, ENV);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], {
    slug: 'a',
    title: 'New',
    url: 'https://askrobin.io/@iser/a',
    published_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-03T00:00:00.000Z',
  });
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

test('writeManifest: PUTs users/<userId>/index.json with manifest JSON', async () => {
  const puts: Array<{ key: string; body: string }> = [];
  const blob = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key: string, body: string | Buffer) => {
      puts.push({ key, body: String(body) });
      return { url: 'u' };
    },
    delBlob: async () => {},
  };
  await writeManifest(blob, ENV, [row({ slug: 'a', ts: '2026-05-01T00:00:00.000Z', title: 'A' })]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, 'users/iser/index.json');
  const parsed = JSON.parse(puts[0].body);
  assert.equal(parsed[0].slug, 'a');
  assert.equal(parsed[0].url, 'https://askrobin.io/@iser/a');
});
