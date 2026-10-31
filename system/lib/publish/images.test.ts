import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { hashAsset, isLocalImageUrl, resolveLocalPath, walkLocalImages } from './images.ts';
import type { BlobClient } from './types.ts';

// --- isLocalImageUrl ---

test('isLocalImageUrl: bare relative path is local', () => {
  assert.equal(isLocalImageUrl('foo.png'), true);
  assert.equal(isLocalImageUrl('./images/x.jpg'), true);
  assert.equal(isLocalImageUrl('../sibling/x.jpg'), true); // resolveLocalPath later rejects traversal
});

test('isLocalImageUrl: file:// is local', () => {
  assert.equal(isLocalImageUrl('file:///tmp/a.png'), true);
  assert.equal(isLocalImageUrl('FILE:///tmp/A.PNG'), true);
});

test('isLocalImageUrl: http/https/data are remote', () => {
  assert.equal(isLocalImageUrl('http://example.com/a.png'), false);
  assert.equal(isLocalImageUrl('https://cdn.example/a.png'), false);
  assert.equal(isLocalImageUrl('data:image/png;base64,aaaa'), false);
});

test('isLocalImageUrl: undefined/empty is not local', () => {
  assert.equal(isLocalImageUrl(undefined), false);
  assert.equal(isLocalImageUrl(''), false);
});

// --- resolveLocalPath: the security-critical seam ---

test('resolveLocalPath: a normal relative path resolves under sourceDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const out = resolveLocalPath('a.png', dir);
  assert.equal(out, resolve(dir, 'a.png'));
});

test('resolveLocalPath: file:// prefix is stripped before resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const abs = resolve(dir, 'pic.png');
  const out = resolveLocalPath(`file://${abs}`, dir);
  assert.equal(out, abs);
});

test('resolveLocalPath: rejects ..-traversal that escapes sourceDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  assert.throws(() => resolveLocalPath('../../etc/passwd', dir), /path traversal rejected/);
});

test('resolveLocalPath: rejects an absolute path outside sourceDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  assert.throws(() => resolveLocalPath('/etc/passwd', dir), /path traversal rejected/);
});

test('resolveLocalPath: rejects file:// with absolute path outside sourceDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  assert.throws(() => resolveLocalPath('file:///etc/passwd', dir), /path traversal rejected/);
});

test('resolveLocalPath: nested-but-within is allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const out = resolveLocalPath('sub/dir/pic.png', dir);
  assert.equal(out, resolve(dir, 'sub/dir/pic.png'));
});

// --- hashAsset ---

test('hashAsset: same bytes → same 16-char hash', () => {
  const a = hashAsset(Buffer.from('hello'));
  const b = hashAsset(Buffer.from('hello'));
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('hashAsset: different bytes → different hash', () => {
  const a = hashAsset(Buffer.from('hello'));
  const b = hashAsset(Buffer.from('world'));
  assert.notEqual(a, b);
});

// --- walkLocalImages end-to-end with real PNG bytes + fake blob client ---

// 1x1 transparent PNG (smallest valid PNG file).
const ONE_PX_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

function fakeBlobClient(): BlobClient & {
  puts: Array<{ key: string; contentType?: string; size: number }>;
  heads: string[];
} {
  const puts: Array<{ key: string; contentType?: string; size: number }> = [];
  const heads: string[] = [];
  return {
    puts,
    heads,
    headBlob: async (key) => {
      heads.push(key);
      return { exists: false };
    },
    putBlob: async (key, body, opts) => {
      puts.push({
        key,
        contentType: opts?.contentType,
        size: typeof body === 'string' ? Buffer.byteLength(body) : body.length,
      });
      return { url: `https://blob.test/${key}` };
    },
    delBlob: async () => {},
  };
}

test('walkLocalImages: uploads a valid PNG with the right contentType + content-hashed key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  writeFileSync(join(dir, 'pic.png'), ONE_PX_PNG);
  const tree = {
    type: 'root',
    children: [{ type: 'image', url: 'pic.png' }],
  } as unknown as Parameters<typeof walkLocalImages>[0]['tree'];
  const blob = fakeBlobClient();
  const res = await walkLocalImages({
    tree,
    sourceDir: dir,
    slug: 's',
    userId: 'u',
    blobClient: blob,
  });
  assert.equal(res.warnings.length, 0);
  assert.equal(res.assetKeys.length, 1);
  assert.equal(blob.puts.length, 1);
  assert.equal(blob.puts[0].contentType, 'image/png');
  // key format: users/<userId>/pages/<slug>/assets/<16hex>.png
  assert.match(blob.puts[0].key, /^users\/u\/pages\/s\/assets\/[0-9a-f]{16}\.png$/);
});

test('walkLocalImages: drops an image when path traversal would escape sourceDir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const tree = {
    type: 'root',
    children: [{ type: 'image', url: '../../../../etc/passwd' }],
  } as unknown as Parameters<typeof walkLocalImages>[0]['tree'];
  const blob = fakeBlobClient();
  const res = await walkLocalImages({
    tree,
    sourceDir: dir,
    slug: 's',
    userId: 'u',
    blobClient: blob,
  });
  assert.equal(res.assetKeys.length, 0);
  assert.equal(blob.puts.length, 0, 'must not upload a traversal target');
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /path traversal rejected/);
});

test('walkLocalImages: drops an image whose bytes are not a recognized image MIME', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  writeFileSync(join(dir, 'not-image.png'), Buffer.from('this is plain text, not png'));
  const tree = {
    type: 'root',
    children: [{ type: 'image', url: 'not-image.png' }],
  } as unknown as Parameters<typeof walkLocalImages>[0]['tree'];
  const blob = fakeBlobClient();
  const res = await walkLocalImages({
    tree,
    sourceDir: dir,
    slug: 's',
    userId: 'u',
    blobClient: blob,
  });
  assert.equal(blob.puts.length, 0, 'plain text masquerading as PNG must NOT upload');
  assert.equal(res.assetKeys.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /could not sniff/);
});

test('walkLocalImages: drops an image that exceeds ASSET_MAX_BYTES', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  // Forge a PNG header + huge padding so file-type sniffs as image/png but byte
  // length exceeds the 10MB cap.
  const huge = Buffer.concat([ONE_PX_PNG, Buffer.alloc(10 * 1024 * 1024 + 1)]);
  writeFileSync(join(dir, 'big.png'), huge);
  const tree = {
    type: 'root',
    children: [{ type: 'image', url: 'big.png' }],
  } as unknown as Parameters<typeof walkLocalImages>[0]['tree'];
  const blob = fakeBlobClient();
  const res = await walkLocalImages({
    tree,
    sourceDir: dir,
    slug: 's',
    userId: 'u',
    blobClient: blob,
  });
  assert.equal(blob.puts.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /exceeds/);
});

test('walkLocalImages: skips re-upload when blob already exists (content-hash dedup)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  writeFileSync(join(dir, 'pic.png'), ONE_PX_PNG);
  const tree = {
    type: 'root',
    children: [{ type: 'image', url: 'pic.png' }],
  } as unknown as Parameters<typeof walkLocalImages>[0]['tree'];
  const blob = fakeBlobClient();
  // Override head to claim the asset already exists.
  blob.headBlob = async () => ({ exists: true, url: 'https://blob.test/existing', size: 1 });
  const res = await walkLocalImages({
    tree,
    sourceDir: dir,
    slug: 's',
    userId: 'u',
    blobClient: blob,
  });
  assert.equal(res.assetKeys.length, 1);
  assert.equal(blob.puts.length, 0, 'identical content must not re-upload');
});

test('walkLocalImages: caps asset count at maxAssets and warns about the drop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgtest-'));
  writeFileSync(join(dir, 'a.png'), ONE_PX_PNG);
  writeFileSync(join(dir, 'b.png'), ONE_PX_PNG);
  writeFileSync(join(dir, 'c.png'), ONE_PX_PNG);
  const tree = {
    type: 'root',
    children: [
      { type: 'image', url: 'a.png' },
      { type: 'image', url: 'b.png' },
      { type: 'image', url: 'c.png' },
    ],
  } as unknown as Parameters<typeof walkLocalImages>[0]['tree'];
  const blob = fakeBlobClient();
  const res = await walkLocalImages({
    tree,
    sourceDir: dir,
    slug: 's',
    userId: 'u',
    blobClient: blob,
    maxAssets: 2,
  });
  // 2 within the cap upload (single content-hash collision means 1 actual put +
  // 1 cache-hit) — what we care about is the warning + the dropped count.
  assert.ok(
    res.warnings.some((w) => /max-assets \(2\)/.test(w) && /dropped 1/.test(w)),
    `expected max-assets warning; got ${JSON.stringify(res.warnings)}`,
  );
});
