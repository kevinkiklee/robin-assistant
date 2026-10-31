import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLog } from './log.ts';
import { pendingPrefix, reconcilePending } from './pending.ts';
import type { BlobClient, LogRow } from './types.ts';

const ENV = {
  token: 'tok',
  userId: 'quinn',
  publicUrl: 'https://askrobin.io',
  blobPublicBaseUrl: 'https://blob.example.com',
  urlSecret: 'test-secret',
};

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

interface FakeStore {
  blobClient: BlobClient;
  deleted: string[];
  pending: Map<string, string>; // pathname → JSON body
}

function makeFakeStore(records: Record<string, unknown>): FakeStore {
  const deleted: string[] = [];
  const map = new Map<string, string>(
    Object.entries(records).map(([name, body]) => [
      `${pendingPrefix(ENV.userId)}${name}`,
      typeof body === 'string' ? body : JSON.stringify(body),
    ]),
  );
  const blobClient: BlobClient = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key) => ({ url: `https://blob.example.com/${key}` }),
    delBlob: async (key) => {
      deleted.push(key);
      map.delete(key);
    },
    listBlobs: async (prefix) =>
      [...map.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((pathname) => ({ pathname, url: `https://blob.example.com/${pathname}` })),
  };
  return { blobClient, deleted, pending: map };
}

function fetchFromStore(store: FakeStore): typeof fetch {
  return (async (url: string | URL) => {
    const pathname = String(url).replace('https://blob.example.com/', '');
    const body = store.pending.get(pathname);
    if (body == null) return new Response('', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

async function makeLog(rows: LogRow[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pending-test-'));
  const logPath = join(dir, 'pub.jsonl');
  await writeFile(
    logPath,
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  );
  return logPath;
}

test('applies a delete op: log row appended, assets + pending blob removed', async () => {
  const logPath = await makeLog([
    row({
      slug: 'gone',
      ts: '2026-05-01T00:00:00.000Z',
      assets: ['users/quinn/pages/gone/assets/a.png'],
    }),
  ]);
  const store = makeFakeStore({
    '1000-delete-gone.json': {
      op: 'delete',
      slug: 'gone',
      ts: '2026-05-02T00:00:00.000Z',
      by: 'index',
    },
  });
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn: fetchFromStore(store),
  });
  assert.deepEqual(res.applied, ['delete:gone']);
  assert.deepEqual(res.stale, []);
  assert.ok(store.deleted.includes('users/quinn/pages/gone/assets/a.png'));
  assert.ok(store.deleted.some((k) => k.endsWith('1000-delete-gone.json')));
  const { entries } = await readLog(logPath);
  const last = entries[entries.length - 1];
  assert.equal(last.action, 'delete');
  assert.equal(last.ts, '2026-05-02T00:00:00.000Z'); // deletion time = action time
  assert.equal(last.source, 'web:index');
});

test('applies a recategorize op as a metadata-only clone row', async () => {
  const logPath = await makeLog([
    row({ slug: 'p', ts: '2026-05-01T00:00:00.000Z', category: 'Essays', description: 'd' }),
  ]);
  const store = makeFakeStore({
    '1000-recategorize-p.json': {
      op: 'recategorize',
      slug: 'p',
      ts: '2026-05-02T00:00:00.000Z',
      category: 'Critiques',
    },
  });
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn: fetchFromStore(store),
  });
  assert.deepEqual(res.applied, ['recategorize:p']);
  const { entries } = await readLog(logPath);
  const last = entries[entries.length - 1];
  assert.equal(last.action, 'recategorize');
  assert.equal(last.category, 'Critiques');
  assert.equal(last.title, 'T'); // cloned — manifest keeps title/description
  assert.equal(last.description, 'd');
  assert.equal(last.blob_key, 'k');
  assert.deepEqual(store.deleted, [`${pendingPrefix('quinn')}1000-recategorize-p.json`]); // no asset sweep
});

test('rejects a recategorize into an unknown category as malformed', async () => {
  const logPath = await makeLog([row({ slug: 'p', ts: '2026-05-01T00:00:00.000Z' })]);
  const store = makeFakeStore({
    '1-recategorize-p.json': {
      op: 'recategorize',
      slug: 'p',
      ts: '2026-05-02T00:00:00.000Z',
      category: 'Bogus',
    },
  });
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn: fetchFromStore(store),
  });
  assert.deepEqual(res.applied, []);
  assert.match(res.warnings[0] ?? '', /malformed/);
  const { entries } = await readLog(logPath);
  assert.equal(entries.length, 1);
});

test('applies two ops on one slug in timestamp order', async () => {
  const logPath = await makeLog([
    row({ slug: 'q', ts: '2026-05-01T00:00:00.000Z', category: 'Essays' }),
  ]);
  const store = makeFakeStore({
    '2000-recategorize-q.json': {
      op: 'recategorize',
      slug: 'q',
      ts: '2026-05-02T00:00:00.000Z',
      category: 'Projects',
    },
    '3000-delete-q.json': { op: 'delete', slug: 'q', ts: '2026-05-03T00:00:00.000Z' },
  });
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn: fetchFromStore(store),
  });
  assert.deepEqual(res.applied, ['recategorize:q', 'delete:q']);
  const { entries } = await readLog(logPath);
  assert.equal(entries[entries.length - 1].action, 'delete');
});

test('drops a stale op when the page was republished after the web action', async () => {
  const logPath = await makeLog([
    row({ slug: 'back', ts: '2026-05-01T00:00:00.000Z' }),
    row({ slug: 'back', ts: '2026-05-03T00:00:00.000Z' }), // republished AFTER web delete
  ]);
  const store = makeFakeStore({
    '1000-delete-back.json': { op: 'delete', slug: 'back', ts: '2026-05-02T00:00:00.000Z' },
  });
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn: fetchFromStore(store),
  });
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.stale, ['delete:back']);
  const { entries } = await readLog(logPath);
  assert.equal(entries.length, 2); // no delete row appended
  assert.equal(store.pending.size, 0); // op consumed
});

test('drops ops for already-deleted and unknown slugs', async () => {
  const logPath = await makeLog([
    row({ slug: 'dead', ts: '2026-05-01T00:00:00.000Z' }),
    row({ slug: 'dead', ts: '2026-05-02T00:00:00.000Z', action: 'delete' }),
  ]);
  const store = makeFakeStore({
    '1-delete-dead.json': { op: 'delete', slug: 'dead', ts: '2026-05-03T00:00:00.000Z' },
    '2-delete-never.json': { op: 'delete', slug: 'never', ts: '2026-05-03T00:00:00.000Z' },
  });
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn: fetchFromStore(store),
  });
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.stale.sort(), ['delete:dead', 'delete:never']);
  assert.equal(store.pending.size, 0);
});

test('keeps an op whose fetch fails, drops a malformed one', async () => {
  const logPath = await makeLog([row({ slug: 'x', ts: '2026-05-01T00:00:00.000Z' })]);
  const store = makeFakeStore({
    '1-delete-x.json': { op: 'delete', slug: 'x', ts: '2026-05-02T00:00:00.000Z' },
    '2-bad.json': 'not json {{{',
  });
  // fetch that 500s for the valid op, serves the malformed one
  const fetchFn = (async (url: string | URL) => {
    if (String(url).includes('1-delete-x.json')) return new Response('', { status: 500 });
    return fetchFromStore(store)(String(url));
  }) as typeof fetch;
  const res = await reconcilePending({
    env: ENV,
    blobClient: store.blobClient,
    logPath,
    fetchFn,
  });
  assert.deepEqual(res.applied, []);
  assert.equal(res.warnings.length, 2);
  assert.ok(store.pending.has(`${pendingPrefix('quinn')}1-delete-x.json`)); // kept for retry
  assert.ok(!store.pending.has(`${pendingPrefix('quinn')}2-bad.json`)); // dropped
});

test('no-ops for a client without listBlobs', async () => {
  const logPath = await makeLog([]);
  const blobClient: BlobClient = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key) => ({ url: key }),
    delBlob: async () => {},
  };
  const res = await reconcilePending({ env: ENV, blobClient, logPath });
  assert.deepEqual(res, { applied: [], stale: [], warnings: [] });
});
