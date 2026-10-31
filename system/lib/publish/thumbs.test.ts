import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { dropThumb, hasPhoto, thumbKey, thumbsIndexKey, updateThumbs } from './thumbs.ts';
import type { BlobClient, PublishEnv } from './types.ts';

const BASE = 'https://store.public.blob.vercel-storage.com';
const ENV: PublishEnv = {
  token: 't',
  userId: 'testuser',
  publicUrl: 'https://askrobin.io',
  blobPublicBaseUrl: BASE,
  urlSecret: 's',
};
const PHOTO = `<img src="${BASE}/users/testuser/pages/p-0123456789/assets/a.jpg">`;

/** In-memory blob store whose public reads go through a stubbed fetch. */
function setup(
  manifest: { slug: string; url: string; updated_at: string }[],
  pages: Record<string, string>,
) {
  const store = new Map<string, string | Buffer>();
  store.set('users/testuser/index.json', JSON.stringify(manifest));
  for (const [pub, html] of Object.entries(pages))
    store.set(`users/testuser/pages/${pub}/index.html`, html);
  const blobClient: BlobClient = {
    headBlob: async (k) => ({ exists: store.has(k) }) as never,
    putBlob: async (k, body) => {
      store.set(k, body);
      return { url: `${BASE}/${k}` } as never;
    },
    delBlob: async (k) => {
      store.delete(k);
    },
  };
  globalThis.fetch = (async (url: string) => {
    const key = String(url).replace(`${BASE}/`, '').replace(/\?.*$/, '');
    const body = store.get(key);
    return body == null
      ? new Response('', { status: 404 })
      : new Response(typeof body === 'string' ? body : new Uint8Array(body));
  }) as typeof fetch;
  return { store, blobClient };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const row = (slug: string, updated = '2026-10-01') => ({
  slug,
  url: `https://askrobin.io/@testuser/${slug}-0123456789`,
  updated_at: updated,
});

test('hasPhoto matches the index cover rule', () => {
  assert.equal(hasPhoto(`<p>x</p>${PHOTO}`), true);
  assert.equal(hasPhoto(PHOTO.replace('<img', '<img width="40"')), false);
  assert.equal(hasPhoto('<img src="https://example.com/a.jpg">'), false);
  assert.equal(hasPhoto('<p>tables only</p>'), false);
});

test('screenshots only photo-less pages, and only when they change', async () => {
  const { store, blobClient } = setup([row('notes'), row('photo')], {
    'notes-0123456789': '<h1>Notes</h1>',
    'photo-0123456789': PHOTO,
  });
  const shots: string[] = [];
  const capture = async (url: string) => {
    shots.push(url);
    return Buffer.from('jpeg');
  };

  const first = await updateThumbs({ env: ENV, blobClient, capture });
  assert.deepEqual(first.captured, ['notes']);
  assert.equal(first.withPhoto, 1);
  assert.deepEqual(shots, ['https://askrobin.io/@testuser/notes-0123456789']);
  assert.ok(store.has(thumbKey('testuser', 'notes-0123456789')));
  const index = JSON.parse(String(store.get(thumbsIndexKey('testuser'))));
  assert.deepEqual(index.notes, {
    url: `${BASE}/users/testuser/thumbs/notes-0123456789.jpg`,
    updated_at: '2026-10-01',
  });

  const again = await updateThumbs({ env: ENV, blobClient, capture });
  assert.equal(again.captured.length, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(shots.length, 1, 'unchanged page not retaken');
});

test('a page that gains a photo loses its screenshot; deleted pages are pruned', async () => {
  const { store, blobClient } = setup([row('notes')], { 'notes-0123456789': '<h1>Notes</h1>' });
  const capture = async () => Buffer.from('jpeg');
  await updateThumbs({ env: ENV, blobClient, capture });

  store.set('users/testuser/index.json', JSON.stringify([row('notes', '2026-10-02')]));
  store.set('users/testuser/pages/notes-0123456789/index.html', PHOTO);
  await updateThumbs({ env: ENV, blobClient, capture });
  assert.equal(store.has(thumbKey('testuser', 'notes-0123456789')), false);
  assert.deepEqual(JSON.parse(String(store.get(thumbsIndexKey('testuser')))), {
    notes: { url: '', updated_at: '2026-10-02', photo: true },
  });
});

test('a failed capture is reported and leaves no entry', async () => {
  const { store, blobClient } = setup([row('notes')], { 'notes-0123456789': '<h1>Notes</h1>' });
  const result = await updateThumbs({ env: ENV, blobClient, capture: async () => null });
  assert.deepEqual(result.failed, ['notes']);
  assert.equal(store.has(thumbsIndexKey('testuser')), false);
});

test('dropThumb removes the screenshot and its index entry', async () => {
  const { store, blobClient } = setup([row('notes')], { 'notes-0123456789': '<h1>Notes</h1>' });
  await updateThumbs({ env: ENV, blobClient, capture: async () => Buffer.from('jpeg') });
  await dropThumb(ENV, blobClient, 'notes');
  assert.equal(store.has(thumbKey('testuser', 'notes-0123456789')), false);
  assert.deepEqual(JSON.parse(String(store.get(thumbsIndexKey('testuser')))), {});
});

test('a concurrent publish’s entry survives this run’s index write', async () => {
  const { store, blobClient } = setup([row('notes')], { 'notes-0123456789': '<h1>Notes</h1>' });
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
  await updateThumbs({ env: ENV, blobClient, capture, slugs: ['notes'] });
  const index = JSON.parse(String(store.get(thumbsIndexKey('testuser'))));
  assert.deepEqual(Object.keys(index).sort(), ['notes', 'other']);
});
