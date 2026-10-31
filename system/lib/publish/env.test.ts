import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { publishEnvFromProcess, publishLogPath } from './env.ts';

const KEYS = [
  'BLOB_READ_WRITE_TOKEN',
  'PUBLISH_USER_ID',
  'PUBLISH_PUBLIC_URL',
  'BLOB_PUBLIC_BASE_URL',
  'PUBLISH_URL_SECRET',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setAll() {
  process.env.BLOB_READ_WRITE_TOKEN = 'tok';
  process.env.PUBLISH_USER_ID = 'u1';
  process.env.BLOB_PUBLIC_BASE_URL = 'https://blob.example.com';
  process.env.PUBLISH_URL_SECRET = 'sekret';
}

test('publishEnvFromProcess fills the default public URL', () => {
  setAll();
  assert.deepEqual(publishEnvFromProcess(), {
    token: 'tok',
    userId: 'u1',
    publicUrl: 'https://askrobin.io',
    blobPublicBaseUrl: 'https://blob.example.com',
    urlSecret: 'sekret',
  });
  process.env.PUBLISH_PUBLIC_URL = 'https://pub.example.com';
  assert.equal(publishEnvFromProcess()?.publicUrl, 'https://pub.example.com');
});

test('publishEnvFromProcess returns null when PUBLISH_URL_SECRET is missing', () => {
  setAll();
  delete process.env.PUBLISH_URL_SECRET;
  assert.equal(publishEnvFromProcess(), null);
});

test('publishEnvFromProcess returns null when any other required value is missing', () => {
  for (const k of ['BLOB_READ_WRITE_TOKEN', 'PUBLISH_USER_ID', 'BLOB_PUBLIC_BASE_URL']) {
    setAll();
    delete process.env[k];
    assert.equal(publishEnvFromProcess(), null, k);
  }
});

test('publishLogPath', () => {
  assert.equal(publishLogPath('/ud'), '/ud/observability/publish/index.jsonl');
});
