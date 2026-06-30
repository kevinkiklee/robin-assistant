import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BlobClient, BlobPutOptions } from './types.ts';
import { publish } from './orchestrate.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PutCall {
  key: string;
  access: string | undefined;
}

interface RecordingBlob {
  blobClient: BlobClient;
  putCalls: PutCall[];
  store: Map<string, string>;
}

function makeRecordingBlob(): RecordingBlob {
  const store = new Map<string, string>();
  const putCalls: PutCall[] = [];

  const blobClient: BlobClient = {
    headBlob: async (key) => ({ exists: store.has(key) }),
    putBlob: async (key, body, opts?: BlobPutOptions) => {
      putCalls.push({ key, access: opts?.access });
      store.set(key, typeof body === 'string' ? body : body.toString('utf8'));
      return { url: `https://blob.example.com/${key}` };
    },
    delBlob: async (key) => {
      store.delete(key);
    },
  };

  return { blobClient, putCalls, store };
}

const TEST_ENV = {
  token: 'tok',
  userId: 'testuser',
  publicUrl: 'https://askrobin.io',
  blobPublicBaseUrl: 'https://blob.example.com',
};

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'publish-test-'));
}

async function makeSourceFile(dir: string, frontmatter: string, name = 'page.md'): Promise<string> {
  const path = join(dir, name);
  await writeFile(
    path,
    `---\n${frontmatter}---\n\n# Test Page\n\nHello world.\n`,
    'utf8',
  );
  return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('publish rejects an unknown category', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient } = makeRecordingBlob();
    const source = await makeSourceFile(dir, 'category: Nope\n');
    await assert.rejects(
      () =>
        publish({
          source,
          slug: 'test-unknown-cat',
          mode: 'overwrite',
          env: TEST_ENV,
          blobClient,
          logPath: join(dir, 'pub.log'),
          telemetryPath: join(dir, 'tel.log'),
        }),
      /unknown category/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('private page stored under private prefix with access:private', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, putCalls } = makeRecordingBlob();
    const { blobClient: privateBlobClient, putCalls: privatePutCalls } = makeRecordingBlob();
    const source = await makeSourceFile(dir, 'category: Field Guides\nvisibility: private\n');
    await publish({
      source,
      slug: 'test-private',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      privateBlobClient,
      logPath: join(dir, 'pub.log'),
      telemetryPath: join(dir, 'tel.log'),
    });
    // Page PUT must go to the PRIVATE client
    const pagePut = privatePutCalls.find(
      (c) => c.key.includes('/private/') && c.key.endsWith('/index.html'),
    );
    assert.ok(pagePut, 'page stored under users/<u>/private/<slug>/index.html on private client');
    assert.equal(pagePut.access, 'private');
    // Must NOT be under /pages/ prefix on the public client
    const publicPut = putCalls.find(
      (c) => c.key.includes('/pages/') && c.key.endsWith('/index.html'),
    );
    assert.equal(publicPut, undefined, 'private page must not appear under /pages/ prefix');
    // index.private.json must go to the PRIVATE client
    const privManifest = privatePutCalls.find((c) => c.key.endsWith('index.private.json'));
    assert.ok(privManifest, 'index.private.json must be written to the private client');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('private publish without privateBlobClient is rejected', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient } = makeRecordingBlob();
    const source = await makeSourceFile(dir, 'category: Field Guides\nvisibility: private\n');
    await assert.rejects(
      () =>
        publish({
          source,
          slug: 'test-private-guard',
          mode: 'overwrite',
          env: TEST_ENV,
          blobClient,
          // no privateBlobClient
          logPath: join(dir, 'pub.log'),
          telemetryPath: join(dir, 'tel.log'),
        }),
      /private blob store/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete private page without privateBlobClient is rejected', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient } = makeRecordingBlob();
    const { blobClient: privateBlobClient } = makeRecordingBlob();
    const logPath = join(dir, 'pub.log');
    const telPath = join(dir, 'tel.log');

    // First: publish the slug as private (succeeds because privateBlobClient is present)
    const source = await makeSourceFile(dir, 'category: Field Guides\nvisibility: private\n');
    await publish({
      source,
      slug: 'private-del-test',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      privateBlobClient,
      logPath,
      telemetryPath: telPath,
    });

    // Now delete WITHOUT the private client — must throw, not silently noop
    await assert.rejects(
      () =>
        publish({
          mode: 'delete',
          slug: 'private-del-test',
          env: TEST_ENV,
          blobClient,
          // no privateBlobClient
          logPath,
          telemetryPath: telPath,
        }),
      /private blob store/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete public page without privateBlobClient succeeds normally', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, store } = makeRecordingBlob();
    const logPath = join(dir, 'pub.log');
    const telPath = join(dir, 'tel.log');

    const source = await makeSourceFile(dir, 'category: Essays\nvisibility: public\n');
    await publish({
      source,
      slug: 'public-del-test',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath: telPath,
    });

    const publicKey = `users/${TEST_ENV.userId}/pages/public-del-test/index.html`;
    assert.ok(store.has(publicKey), 'public blob must exist after publish');

    const result = await publish({
      mode: 'delete',
      slug: 'public-del-test',
      env: TEST_ENV,
      blobClient,
      // no privateBlobClient — public delete must still work
      logPath,
      telemetryPath: telPath,
    });
    assert.equal(result.action, 'delete');
    assert.equal(store.has(publicKey), false, 'public blob must be removed after delete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('visibility flip: stale public blob deleted when republished as private', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, store } = makeRecordingBlob();
    const { blobClient: privateBlobClient, store: privateStore } = makeRecordingBlob();
    const logPath = join(dir, 'pub.log');
    const telPath = join(dir, 'tel.log');

    const publicKey = `users/${TEST_ENV.userId}/pages/flip-slug/index.html`;
    const privateKey = `users/${TEST_ENV.userId}/private/flip-slug/index.html`;

    // First publish: public
    const srcPublic = await makeSourceFile(dir, 'category: Essays\nvisibility: public\n', 'pub.md');
    await publish({
      source: srcPublic,
      slug: 'flip-slug',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      privateBlobClient,
      logPath,
      telemetryPath: telPath,
    });
    assert.ok(store.has(publicKey), 'public blob must exist after first publish');

    // Second publish: same slug, now private
    const srcPrivate = await makeSourceFile(
      dir,
      'category: Field Guides\nvisibility: private\n',
      'priv.md',
    );
    await publish({
      source: srcPrivate,
      slug: 'flip-slug',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      privateBlobClient,
      logPath,
      telemetryPath: telPath,
    });

    assert.ok(privateStore.has(privateKey), 'private blob must exist in the private store after second publish');
    assert.equal(
      store.has(publicKey),
      false,
      'stale public blob must be deleted from public store after visibility flip to private',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
