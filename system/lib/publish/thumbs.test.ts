import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { appendLogEntry } from './log.ts';
import { toPublicSlug } from './slug.ts';
import { dropThumb, hasPhoto, thumbKey, thumbsIndexKey, updateThumbs } from './thumbs.ts';
import type { BlobClient, LogRow, PublishEnv } from './types.ts';

const BASE = 'https://store.public.blob.vercel-storage.com';
const ENV: PublishEnv = {
  token: 't',
  userId: 'testuser',
  publicUrl: 'https://askrobin.io',
  blobPublicBaseUrl: BASE,
  urlSecret: 's',
};
const PHOTO = `<img src="${BASE}/users/testuser/pages/p-0123456789/assets/a.jpg">`;
const MANIFEST_KEY = 'users/testuser/index.json';

/** The page's public (hashed) slug, as buildManifest derives it. */
const pub = (slug: string) => toPublicSlug(ENV.userId, slug, ENV.urlSecret);
const pageUrl = (slug: string) => `https://askrobin.io/@testuser/${pub(slug)}`;

const logRow = (slug: string, ts = '2026-10-01T00:00:00.000Z', action = 'overwrite'): LogRow => ({
  ts,
  action: action as LogRow['action'],
  slug,
  url: pageUrl(slug),
  user_id: 'testuser',
  source: null,
  blob_key: `users/testuser/pages/${pub(slug)}/index.html`,
  title: slug,
  assets: [],
  warnings: [],
});

const dirs: string[] = [];

/**
 * A local publish log plus an in-memory blob store whose public reads go
 * through a stubbed fetch. Every fetched URL and put key is recorded so tests
 * can assert the retired `users/<id>/index.json` manifest is never touched.
 */
async function setup(rows: LogRow[], pages: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'robin-thumbs-test-'));
  dirs.push(dir);
  const logPath = join(dir, 'index.jsonl');
  for (const r of rows) await appendLogEntry(logPath, r);
  const store = new Map<string, string | Buffer>();
  // A stale manifest blob that must be ignored: the log is the source of truth.
  store.set(
    MANIFEST_KEY,
    JSON.stringify([{ slug: 'ghost', url: pageUrl('ghost'), updated_at: 'x' }]),
  );
  for (const [slug, html] of Object.entries(pages))
    store.set(`users/testuser/pages/${pub(slug)}/index.html`, html);
  const fetched: string[] = [];
  const puts: string[] = [];
  const blobClient: BlobClient = {
    headBlob: async (k) => ({ exists: store.has(k) }) as never,
    putBlob: async (k, body) => {
      puts.push(k);
      store.set(k, body);
      return { url: `${BASE}/${k}` } as never;
    },
    delBlob: async (k) => {
      store.delete(k);
    },
  };
  globalThis.fetch = (async (url: string) => {
    const key = String(url).replace(`${BASE}/`, '').replace(/\?.*$/, '');
    fetched.push(key);
    const body = store.get(key);
    return body == null
      ? new Response('', { status: 404 })
      : new Response(typeof body === 'string' ? body : new Uint8Array(body));
  }) as typeof fetch;
  const opts = { env: ENV, blobClient, logPath };
  return { store, blobClient, logPath, fetched, puts, opts };
}

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test('hasPhoto matches the cover rule', () => {
  assert.equal(hasPhoto(`<p>x</p>${PHOTO}`), true);
  assert.equal(hasPhoto(PHOTO.replace('<img', '<img width="40"')), false);
  assert.equal(hasPhoto('<img src="https://example.com/a.jpg">'), false);
  assert.equal(hasPhoto('<p>tables only</p>'), false);
});

test('screenshots only photo-less pages, and only when they change', async () => {
  const { store, opts, fetched, puts } = await setup([logRow('notes'), logRow('photo')], {
    notes: '<h1>Notes</h1>',
    photo: PHOTO,
  });
  const shots: string[] = [];
  const capture = async (url: string) => {
    shots.push(url);
    return Buffer.from('jpeg');
  };

  const first = await updateThumbs({ ...opts, capture });
  assert.deepEqual(first.captured, ['notes']);
  assert.equal(first.withPhoto, 1);
  assert.deepEqual(shots, [pageUrl('notes')]);
  assert.ok(store.has(thumbKey('testuser', pub('notes'))));
  const index = JSON.parse(String(store.get(thumbsIndexKey('testuser'))));
  assert.deepEqual(index.notes, {
    url: `${BASE}/users/testuser/thumbs/${pub('notes')}.jpg`,
    updated_at: '2026-10-01T00:00:00.000Z',
  });

  const again = await updateThumbs({ ...opts, capture });
  assert.equal(again.captured.length, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(shots.length, 1, 'unchanged page not retaken');
  assert.equal(index.ghost, undefined, 'a manifest-only slug is never captured');
  assert.ok(!fetched.includes(MANIFEST_KEY), 'manifest never fetched');
  assert.ok(!puts.includes(MANIFEST_KEY), 'manifest never written');
});

test('a page that gains a photo loses its screenshot; deleted pages are pruned', async () => {
  const { store, opts, logPath } = await setup([logRow('notes'), logRow('gone')], {
    notes: '<h1>Notes</h1>',
    gone: '<h1>Gone</h1>',
  });
  const capture = async () => Buffer.from('jpeg');
  await updateThumbs({ ...opts, capture });
  assert.ok(store.has(thumbKey('testuser', pub('gone'))));

  await appendLogEntry(logPath, logRow('notes', '2026-10-02T00:00:00.000Z'));
  await appendLogEntry(logPath, logRow('gone', '2026-10-02T00:00:00.000Z', 'delete'));
  store.set(`users/testuser/pages/${pub('notes')}/index.html`, PHOTO);
  const second = await updateThumbs({ ...opts, capture });
  assert.deepEqual(second.removed, ['gone'], 'a slug deleted in the log is pruned');
  assert.equal(store.has(thumbKey('testuser', pub('notes'))), false);
  assert.equal(store.has(thumbKey('testuser', pub('gone'))), false);
  assert.deepEqual(JSON.parse(String(store.get(thumbsIndexKey('testuser')))), {
    notes: { url: '', updated_at: '2026-10-02T00:00:00.000Z', photo: true },
  });
});

test('a failed capture is reported and leaves no entry', async () => {
  const { store, opts } = await setup([logRow('notes')], { notes: '<h1>Notes</h1>' });
  const result = await updateThumbs({ ...opts, capture: async () => null });
  assert.deepEqual(result.failed, ['notes']);
  assert.equal(store.has(thumbsIndexKey('testuser')), false);
});

test('dropThumb removes the screenshot and its index entry', async () => {
  const { store, blobClient, opts } = await setup([logRow('notes')], { notes: '<h1>Notes</h1>' });
  await updateThumbs({ ...opts, capture: async () => Buffer.from('jpeg') });
  await dropThumb(ENV, blobClient, 'notes');
  assert.equal(store.has(thumbKey('testuser', pub('notes'))), false);
  assert.deepEqual(JSON.parse(String(store.get(thumbsIndexKey('testuser')))), {});
});

test('a concurrent publish’s entry survives this run’s index write', async () => {
  const { store, opts } = await setup([logRow('notes')], { notes: '<h1>Notes</h1>' });
  // While this run is capturing, another publish writes its own entry.
  const capture = async () => {
    store.set(
      thumbsIndexKey('testuser'),
      JSON.stringify({
        other: { url: `${BASE}/users/testuser/thumbs/other-0123456789.jpg`, updated_at: 'x' },
      }),
    );
    return Buffer.from('jpeg');
  };
  await updateThumbs({ ...opts, capture, slugs: ['notes'] });
  const index = JSON.parse(String(store.get(thumbsIndexKey('testuser'))));
  assert.deepEqual(Object.keys(index).sort(), ['notes', 'other']);
});

test('a missing or empty log prunes nothing (a wrong logPath must not wipe every thumbnail)', async () => {
  const { store, opts } = await setup([logRow('notes')], { notes: '<h1>Notes</h1>' });
  await updateThumbs({ ...opts, capture: async () => Buffer.from('jpeg') });
  const result = await updateThumbs({
    ...opts,
    logPath: join(opts.logPath, '..', 'missing.jsonl'),
    capture: async () => Buffer.from('jpeg'),
  });
  assert.deepEqual(result.removed, []);
  assert.ok(store.has(thumbKey('testuser', pub('notes'))));
});
