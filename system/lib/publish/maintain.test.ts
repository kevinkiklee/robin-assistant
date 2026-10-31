import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLog } from './log.ts';
import { deletePage, recategorize, syncDeletes } from './maintain.ts';
import { PublishError } from './orchestrate.ts';
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
  url: 'https://askrobin.io/@quinn/s-0123456789',
  user_id: 'quinn',
  source: '/tmp/s.md',
  blob_key: 'users/quinn/pages/s-0123456789/index.html',
  title: 'T',
  assets: ['users/quinn/pages/s/assets/a.png'],
  warnings: [],
  category: 'Essays',
  ...o,
});

function makeBlob(): { blobClient: BlobClient; puts: Map<string, string> } {
  const puts = new Map<string, string>();
  const blobClient: BlobClient = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key, body) => {
      puts.set(key, typeof body === 'string' ? body : body.toString('utf8'));
      return { url: `https://blob.example.com/${key}` };
    },
    delBlob: async () => {},
    listBlobs: async () => [],
  };
  return { blobClient, puts };
}

async function makeLog(rows: LogRow[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maintain-test-'));
  const logPath = join(dir, 'pub.jsonl');
  await writeFile(
    logPath,
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  );
  return logPath;
}

test('recategorize appends a clone row and rewrites the manifest', async () => {
  const logPath = await makeLog([row({})]);
  const { blobClient, puts } = makeBlob();
  const res = await recategorize({
    env: ENV,
    blobClient,
    logPath,
    slug: 's',
    category: 'Critiques',
  });
  assert.equal(res.category, 'Critiques');
  assert.deepEqual(res.warnings, []);

  const { entries } = await readLog(logPath);
  assert.equal(entries.length, 2);
  const appended = entries[1];
  assert.equal(appended.action, 'recategorize');
  assert.equal(appended.category, 'Critiques');
  assert.equal(appended.title, 'T'); // cloned so the manifest keeps its title
  assert.equal(appended.blob_key, entries[0].blob_key); // delete stays findable

  const manifest = JSON.parse(puts.get('users/quinn/index.json') ?? '[]');
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].category, 'Critiques');
  assert.equal(manifest[0].updated_at, '2026-05-01T00:00:00.000Z'); // not bumped
});

test('recategorize is a no-op when the category already matches', async () => {
  const logPath = await makeLog([row({})]);
  const { blobClient } = makeBlob();
  const res = await recategorize({ env: ENV, blobClient, logPath, slug: 's', category: 'Essays' });
  assert.match(res.warnings[0] ?? '', /no-op/);
  const { entries } = await readLog(logPath);
  assert.equal(entries.length, 1);
});

test('recategorize rejects unknown categories, unknown slugs, and deleted slugs', async () => {
  const logPath = await makeLog([
    row({}),
    row({ slug: 'gone', ts: '2026-05-02T00:00:00.000Z' }),
    row({ slug: 'gone', ts: '2026-05-03T00:00:00.000Z', action: 'delete' }),
  ]);
  const { blobClient } = makeBlob();
  await assert.rejects(
    () => recategorize({ env: ENV, blobClient, logPath, slug: 's', category: 'Nope' }),
    (e: unknown) => e instanceof PublishError && /unknown category/.test(e.message),
  );
  await assert.rejects(
    () => recategorize({ env: ENV, blobClient, logPath, slug: 'nope', category: 'Essays' }),
    /unknown slug/,
  );
  await assert.rejects(
    () => recategorize({ env: ENV, blobClient, logPath, slug: 'gone', category: 'Essays' }),
    /deleted/,
  );
});

test('syncDeletes reconciles pending ops and reports the live count', async () => {
  const logPath = await makeLog([row({}), row({ slug: 'doomed', ts: '2026-05-02T00:00:00.000Z' })]);
  const { puts } = makeBlob();
  const tombPath = 'users/quinn/pending/1000-delete-doomed.json';
  const tombBody = JSON.stringify({
    op: 'delete',
    slug: 'doomed',
    ts: '2026-05-04T00:00:00.000Z',
    by: 'index',
  });
  let tombAlive = true;
  const blobClient: BlobClient = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key, body) => {
      puts.set(key, typeof body === 'string' ? body : body.toString('utf8'));
      return { url: key };
    },
    delBlob: async (key) => {
      if (key === tombPath) tombAlive = false;
    },
    listBlobs: async (prefix) =>
      tombAlive && tombPath.startsWith(prefix)
        ? [{ pathname: tombPath, url: `https://blob.example.com/${tombPath}` }]
        : [],
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(tombBody, { status: 200 })) as typeof fetch;
  try {
    const res = await syncDeletes({ env: ENV, blobClient, logPath });
    assert.deepEqual(res.applied, ['delete:doomed']);
    assert.equal(res.manifest_entries, 1); // only 's' remains
    const manifest = JSON.parse(puts.get('users/quinn/index.json') ?? '[]');
    assert.deepEqual(
      manifest.map((m: { slug: string }) => m.slug),
      ['s'],
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- deletePage ---

const DENV = {
  token: 'tok',
  userId: 'u1',
  publicUrl: 'https://askrobin.io',
  blobPublicBaseUrl: 'https://blob.example.com',
  urlSecret: 'test-secret',
};
const PAGE_KEY = 'users/u1/pages/bike-fit-notes-0123456789/index.html';
const dRow = (o: Partial<LogRow> = {}): LogRow =>
  row({
    slug: 'bike-fit-notes',
    user_id: 'u1',
    url: 'https://askrobin.io/@u1/bike-fit-notes-0123456789',
    blob_key: PAGE_KEY,
    assets: [],
    ...o,
  });

function makeDeleteHarness(opts: { failThumbIndexPut?: boolean } = {}) {
  const dels: string[] = [];
  const puts: string[] = [];
  const blobClient: BlobClient = {
    headBlob: async (k) => ({ exists: k === PAGE_KEY }),
    putBlob: async (k) => {
      if (opts.failThumbIndexPut && k === 'users/u1/thumbs/index.json') throw new Error('boom');
      puts.push(k);
      return { url: `https://blob.example.com/${k}` };
    },
    delBlob: async (k) => {
      dels.push(k);
    },
    listBlobs: async () => [],
  };
  const thumbIndex = {
    'bike-fit-notes': {
      url: 'https://blob.example.com/users/u1/thumbs/bike-fit-notes-0123456789.jpg',
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    String(url).includes('users/u1/thumbs/index.json')
      ? new Response(JSON.stringify(thumbIndex))
      : new Response('', { status: 404 })) as typeof fetch;
  return { blobClient, dels, puts, restore: () => (globalThis.fetch = realFetch) };
}

test('deletePage deletes the page, logs a delete row, and drops the thumbnail', async () => {
  const h = makeDeleteHarness();
  try {
    const logPath = await makeLog([dRow()]);
    const res = await deletePage({
      env: DENV,
      blobClient: h.blobClient,
      logPath,
      slug: 'bike-fit-notes',
      telemetryPath: join(logPath, '..', 'telemetry.log'),
    });
    assert.equal(res.action, 'delete');
    assert.ok(h.dels.includes(PAGE_KEY));
    assert.ok(h.dels.includes('users/u1/thumbs/bike-fit-notes-0123456789.jpg'));
    const { entries } = await readLog(logPath);
    assert.equal(entries.at(-1)?.action, 'delete');
    assert.equal(entries.at(-1)?.slug, 'bike-fit-notes');
    assert.deepEqual(res.warnings, []);
  } finally {
    h.restore();
  }
});

test('deletePage turns a thumbnail failure into a warning', async () => {
  const h = makeDeleteHarness({ failThumbIndexPut: true });
  try {
    const logPath = await makeLog([dRow()]);
    const res = await deletePage({
      env: DENV,
      blobClient: h.blobClient,
      logPath,
      slug: 'bike-fit-notes',
      telemetryPath: join(logPath, '..', 'telemetry.log'),
    });
    assert.equal(res.action, 'delete');
    assert.ok(h.dels.includes(PAGE_KEY));
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /thumbnail cleanup failed: boom/);
  } finally {
    h.restore();
  }
});

test('deletePage dry-run touches nothing', async () => {
  const h = makeDeleteHarness();
  try {
    const logPath = await makeLog([dRow()]);
    const res = await deletePage({
      env: DENV,
      blobClient: h.blobClient,
      logPath,
      slug: 'bike-fit-notes',
      dryRun: true,
    });
    assert.equal(res.dry_run, true);
    assert.deepEqual(h.dels, []);
    assert.deepEqual(h.puts, []);
  } finally {
    h.restore();
  }
});
