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

function mkRow(
  p: Partial<LogRow> & { slug: string; ts: string; action: LogRow['action'] },
): LogRow {
  return {
    url: '',
    user_id: 'u',
    source: null,
    blob_key: '',
    title: p.slug,
    assets: [],
    warnings: [],
    ...p,
  } as LogRow;
}

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
    category: 'Uncategorized',
    visibility: 'public',
    description: null,
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
  // No private client → only the public manifest is PUT (writing private-access
  // blobs to the public store would throw, so the private manifest is skipped).
  assert.equal(puts.length, 1);
  assert.ok(!puts.some((p) => p.key === 'users/iser/index.private.json'));
  const pub = puts.find((p) => p.key === 'users/iser/index.json');
  assert.ok(pub);
  const parsed = JSON.parse(pub.body);
  assert.equal(parsed[0].slug, 'a');
  assert.equal(parsed[0].url, 'https://askrobin.io/@iser/a');
});

test('writeManifest with no private client skips index.private.json even when private entries exist', async () => {
  const puts: Array<{ key: string }> = [];
  const blob = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key: string) => {
      puts.push({ key });
      return { url: 'u' };
    },
    delBlob: async () => {},
  };
  const rows = [
    mkRow({ slug: 'pub', ts: '2026-01-01T00:00:00Z', action: 'append', visibility: 'public' }),
    mkRow({ slug: 'priv', ts: '2026-01-02T00:00:00Z', action: 'append', visibility: 'private' }),
  ];
  // No private client (3-arg call) → index.private.json must be skipped entirely
  await writeManifest(blob, { publicUrl: 'https://x', userId: 'u' }, rows);
  assert.equal(puts.length, 1);
  assert.ok(!puts.some((p) => p.key === 'users/u/index.private.json'));
});

test('buildManifest carries category/visibility/description from latest row', () => {
  const rows = [
    mkRow({
      slug: 'a',
      ts: '2026-01-01T00:00:00Z',
      action: 'append',
      category: 'Essays',
      visibility: 'public',
      description: 'd1',
    }),
    mkRow({
      slug: 'a',
      ts: '2026-02-01T00:00:00Z',
      action: 'overwrite',
      category: 'Field Guides',
      visibility: 'private',
      description: 'd2',
    }),
  ];
  const m = buildManifest(rows, { publicUrl: 'https://x', userId: 'u' });
  assert.equal(m[0].category, 'Field Guides');
  assert.equal(m[0].visibility, 'private');
  assert.equal(m[0].description, 'd2');
});

test('buildManifest defaults legacy rows (no category/visibility) safely', () => {
  const rows = [mkRow({ slug: 'b', ts: '2026-01-01T00:00:00Z', action: 'append' })];
  const m = buildManifest(rows, { publicUrl: 'https://x', userId: 'u' });
  assert.equal(m[0].category, 'Uncategorized');
  assert.equal(m[0].visibility, 'public');
  assert.equal(m[0].description, null);
});

test('writeManifest writes public array + private array to the right stores', async () => {
  type PutRecord = { key: string; body: string; access?: string };
  const pubPuts: PutRecord[] = [];
  const privPuts: PutRecord[] = [];

  function makeBlob(puts: PutRecord[]) {
    return {
      headBlob: async () => ({ exists: false }),
      putBlob: async (key: string, body: string | Buffer, opts?: { access?: string }) => {
        puts.push({
          key,
          body: typeof body === 'string' ? body : body.toString('utf8'),
          access: opts?.access,
        });
        return { url: 'u' };
      },
      delBlob: async () => {},
    };
  }

  const pubBlob = makeBlob(pubPuts);
  const privBlob = makeBlob(privPuts);

  const rows = [
    mkRow({
      slug: 'pub',
      ts: '2026-01-01T00:00:00Z',
      action: 'append',
      category: 'Essays',
      visibility: 'public',
    }),
    mkRow({
      slug: 'priv',
      ts: '2026-01-02T00:00:00Z',
      action: 'append',
      category: 'Essays',
      visibility: 'private',
    }),
  ];
  await writeManifest(pubBlob, { publicUrl: 'https://x', userId: 'u' }, rows, privBlob);

  // Public index goes to the PUBLIC client
  const pub = pubPuts.find((p) => p.key === 'users/u/index.json');
  assert.ok(pub, 'index.json must be written to the public client');
  assert.deepEqual(
    JSON.parse(pub.body).map((e: { slug: string }) => e.slug),
    ['pub'],
  );

  // Private index goes to the PRIVATE client (not the public one)
  const prv = privPuts.find((p) => p.key === 'users/u/index.private.json');
  assert.ok(prv, 'index.private.json must be written to the private client');
  assert.equal(prv.access, 'private');
  assert.deepEqual(
    JSON.parse(prv.body).map((e: { slug: string }) => e.slug),
    ['priv'],
  );

  // Private index must NOT appear in public puts
  assert.ok(
    !pubPuts.some((p) => p.key === 'users/u/index.private.json'),
    'index.private.json must not be written to the public client',
  );
});
