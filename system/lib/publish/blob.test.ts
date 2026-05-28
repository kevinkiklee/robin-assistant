import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBlobClient, type DelFn, type HeadFn, type PutFn } from './blob.ts';

const noSleep = () => Promise.resolve();

// --- headBlob ---

test('headBlob: returns exists:true with metadata on success', async () => {
  const headFn: HeadFn = async () => ({
    size: 1234,
    url: 'https://blob/test',
    uploadedAt: '2026-01-01T00:00:00Z',
  });
  const c = createBlobClient({ token: 't', headFn, putFn: stubPut(), delFn: stubDel() });
  const r = await c.headBlob('p/x');
  assert.equal(r.exists, true);
  assert.equal(r.size, 1234);
  assert.equal(r.url, 'https://blob/test');
});

test('headBlob: returns exists:false on 404-status error', async () => {
  const headFn: HeadFn = async () => {
    throw Object.assign(new Error('blob missing'), { status: 404 });
  };
  const c = createBlobClient({ token: 't', headFn, putFn: stubPut(), delFn: stubDel() });
  const r = await c.headBlob('p/x');
  assert.equal(r.exists, false);
});

test('headBlob: returns exists:false when error class is BlobNotFoundError', async () => {
  class BlobNotFoundError extends Error {}
  const headFn: HeadFn = async () => {
    throw new BlobNotFoundError('not found');
  };
  const c = createBlobClient({ token: 't', headFn, putFn: stubPut(), delFn: stubDel() });
  const r = await c.headBlob('p/x');
  assert.equal(r.exists, false);
});

test('headBlob: returns exists:false when message matches /not found/i', async () => {
  const headFn: HeadFn = async () => {
    throw new Error('Resource Not Found at upstream');
  };
  const c = createBlobClient({ token: 't', headFn, putFn: stubPut(), delFn: stubDel() });
  const r = await c.headBlob('p/x');
  assert.equal(r.exists, false);
});

test('headBlob: rethrows non-404 errors', async () => {
  const headFn: HeadFn = async () => {
    throw Object.assign(new Error('boom'), { status: 500 });
  };
  const c = createBlobClient({ token: 't', headFn, putFn: stubPut(), delFn: stubDel() });
  await assert.rejects(c.headBlob('p/x'), /boom/);
});

// --- putBlob retry behavior ---

test('putBlob: succeeds on first try; sleepFn never called', async () => {
  let sleepCount = 0;
  let putCount = 0;
  const putFn: PutFn = async (_key, _body, _opts) => {
    putCount++;
    return { url: 'https://blob/out', pathname: 'p/out' };
  };
  const c = createBlobClient({
    token: 't',
    putFn,
    headFn: stubHead(),
    delFn: stubDel(),
    sleepFn: async () => {
      sleepCount++;
    },
  });
  const r = await c.putBlob('p/out', 'hello');
  assert.equal(r.url, 'https://blob/out');
  assert.equal(putCount, 1);
  assert.equal(sleepCount, 0);
});

test('putBlob: retries on 429 then succeeds', async () => {
  let attempt = 0;
  const sleepDelays: number[] = [];
  const putFn: PutFn = async () => {
    attempt++;
    if (attempt < 3) throw Object.assign(new Error('rate-limited'), { status: 429 });
    return { url: 'https://blob/eventual', pathname: 'p/eventual' };
  };
  const c = createBlobClient({
    token: 't',
    putFn,
    headFn: stubHead(),
    delFn: stubDel(),
    sleepFn: async (ms) => {
      sleepDelays.push(ms);
    },
  });
  const r = await c.putBlob('p/eventual', 'body');
  assert.equal(r.url, 'https://blob/eventual');
  assert.equal(attempt, 3);
  // First and second failures each trigger a sleep before retry.
  assert.deepEqual(sleepDelays, [200, 800]);
});

test('putBlob: gives up after BLOB_RETRY_MAX and throws wrapped error', async () => {
  let attempt = 0;
  const putFn: PutFn = async () => {
    attempt++;
    throw Object.assign(new Error('still 503'), { status: 503 });
  };
  const c = createBlobClient({
    token: 't',
    putFn,
    headFn: stubHead(),
    delFn: stubDel(),
    sleepFn: noSleep,
  });
  await assert.rejects(c.putBlob('p/fail', 'body'), (err: Error & { status?: number }) => {
    assert.match(err.message, /upstream PUT failed/);
    assert.match(err.message, /still 503/);
    assert.equal(err.status, 503);
    return true;
  });
  // 1 initial attempt + 3 retries = 4 total.
  assert.equal(attempt, 4);
});

test('putBlob: non-retryable status (404) does NOT retry', async () => {
  let attempt = 0;
  const putFn: PutFn = async () => {
    attempt++;
    throw Object.assign(new Error('bad path'), { status: 404 });
  };
  const c = createBlobClient({
    token: 't',
    putFn,
    headFn: stubHead(),
    delFn: stubDel(),
    sleepFn: noSleep,
  });
  await assert.rejects(c.putBlob('p/x', 'body'));
  assert.equal(attempt, 1);
});

test('putBlob: error without status IS retried (treated as transient)', async () => {
  let attempt = 0;
  const putFn: PutFn = async () => {
    attempt++;
    if (attempt < 2) throw new Error('network blip');
    return { url: 'https://blob/ok', pathname: 'p/ok' };
  };
  const c = createBlobClient({
    token: 't',
    putFn,
    headFn: stubHead(),
    delFn: stubDel(),
    sleepFn: noSleep,
  });
  const r = await c.putBlob('p/ok', 'body');
  assert.equal(r.url, 'https://blob/ok');
  assert.equal(attempt, 2);
});

test('putBlob: forwards options (contentType, allowOverwrite, cacheControlMaxAge)', async () => {
  let captured: {
    access: string;
    contentType?: string;
    allowOverwrite: boolean;
    cacheControlMaxAge?: number;
  } | null = null;
  const putFn: PutFn = async (_key, _body, opts) => {
    captured = {
      access: opts.access,
      contentType: opts.contentType,
      allowOverwrite: opts.allowOverwrite,
      cacheControlMaxAge: opts.cacheControlMaxAge,
    };
    return { url: 'https://blob/x', pathname: 'p/x' };
  };
  const c = createBlobClient({ token: 't', putFn, headFn: stubHead(), delFn: stubDel() });
  await c.putBlob('p/x', 'body', {
    contentType: 'text/html',
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
  assert.deepEqual(captured, {
    access: 'public',
    contentType: 'text/html',
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
});

test('putBlob: allowOverwrite defaults to false; cacheControlMaxAge omitted when undefined', async () => {
  let capturedKeys: string[] = [];
  let capturedAllowOverwrite: boolean | undefined;
  const putFn: PutFn = async (_key, _body, opts) => {
    capturedKeys = Object.keys(opts);
    capturedAllowOverwrite = opts.allowOverwrite;
    return { url: 'https://blob/y' };
  };
  const c = createBlobClient({ token: 't', putFn, headFn: stubHead(), delFn: stubDel() });
  await c.putBlob('p/y', 'body');
  assert.equal(capturedAllowOverwrite, false);
  assert.ok(!capturedKeys.includes('cacheControlMaxAge'), 'cacheControlMaxAge must be omitted');
});

// --- delBlob ---

test('delBlob: succeeds on first try', async () => {
  let called = false;
  const delFn: DelFn = async () => {
    called = true;
  };
  const c = createBlobClient({ token: 't', delFn, headFn: stubHead(), putFn: stubPut() });
  await c.delBlob('p/x');
  assert.equal(called, true);
});

test('delBlob: swallows 404 (idempotent delete)', async () => {
  const delFn: DelFn = async () => {
    throw Object.assign(new Error('gone'), { status: 404 });
  };
  const c = createBlobClient({
    token: 't',
    delFn,
    headFn: stubHead(),
    putFn: stubPut(),
    sleepFn: noSleep,
  });
  await c.delBlob('p/x'); // should not throw
});

test('delBlob: retries on 503 then rethrows after max', async () => {
  let attempt = 0;
  const delFn: DelFn = async () => {
    attempt++;
    throw Object.assign(new Error('upstream'), { status: 503 });
  };
  const c = createBlobClient({
    token: 't',
    delFn,
    headFn: stubHead(),
    putFn: stubPut(),
    sleepFn: noSleep,
  });
  await assert.rejects(c.delBlob('p/x'), /upstream DELETE failed/);
  assert.equal(attempt, 4);
});

// --- guards ---

test('createBlobClient: throws when token missing', () => {
  assert.throws(() => createBlobClient({ token: '' }), /createBlobClient: token required/);
});

// --- helpers ---

function stubPut(): PutFn {
  return async () => ({ url: 'stub', pathname: 'stub' });
}
function stubHead(): HeadFn {
  return async () => ({ size: 0, url: 'stub', uploadedAt: '' });
}
function stubDel(): DelFn {
  return async () => {};
}
