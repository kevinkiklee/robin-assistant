import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publish } from './orchestrate.ts';
import { toPublicSlug } from './slug.ts';
import type { BlobClient, BlobPutOptions } from './types.ts';

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
  urlSecret: 'test-url-secret',
};

const pub = (slug: string): string => toPublicSlug(TEST_ENV.userId, slug, TEST_ENV.urlSecret);
const keyFor = (slug: string): string => `users/${TEST_ENV.userId}/pages/${pub(slug)}/index.html`;
const MANIFEST_KEY = `users/${TEST_ENV.userId}/index.json`;

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'publish-test-'));
}

async function makeSourceFile(
  dir: string,
  frontmatter: string,
  name = 'page.md',
  body = '# Test Page\n\nHello world.\n',
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `---\n${frontmatter}---\n\n${body}`, 'utf8');
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

test('visibility: private is refused (private pages removed)', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient } = makeRecordingBlob();
    const source = await makeSourceFile(dir, 'category: Field Guides\nvisibility: private\n');
    await assert.rejects(
      () =>
        publish({
          source,
          slug: 'test-private',
          mode: 'overwrite',
          env: TEST_ENV,
          blobClient,
          logPath: join(dir, 'pub.log'),
          telemetryPath: join(dir, 'tel.log'),
        }),
      /removed/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('page is stored under the hashed slug with access:public; result url carries the hash', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, putCalls, store } = makeRecordingBlob();
    const source = await makeSourceFile(dir, 'category: Essays\n');
    const result = await publish({
      source,
      slug: 'hash-me',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath: join(dir, 'pub.log'),
      telemetryPath: join(dir, 'tel.log'),
    });

    assert.equal(result.slug, 'hash-me');
    assert.equal(result.url, `https://askrobin.io/@testuser/${pub('hash-me')}`);
    assert.match(result.url, /\/hash-me-[0-9a-f]{10}$/);
    assert.equal(result.blob_key, keyFor('hash-me'));
    assert.ok(store.has(keyFor('hash-me')), 'blob stored at hashed key');
    assert.ok(!store.has('users/testuser/pages/hash-me/index.html'), 'no unhashed blob');

    const pagePut = putCalls.find((c) => c.key === keyFor('hash-me'));
    assert.equal(pagePut?.access, 'public');

    // The page HTML's canonical URL points at the hashed /@user/ path.
    const html = store.get(keyFor('hash-me'))!;
    assert.ok(html.includes(`href="https://askrobin.io/@testuser/${pub('hash-me')}"`));

    // The retired index manifest is never written.
    assert.ok(!putCalls.some((c) => c.key === MANIFEST_KEY), 'no index.json put');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publish + delete never touch index.json or pending ops; thumbs read the local log', async () => {
  const dir = await makeTmpDir();
  const realFetch = globalThis.fetch;
  try {
    const { blobClient: inner, putCalls, store } = makeRecordingBlob();
    const listed: string[] = [];
    const blobClient: BlobClient = {
      ...inner,
      listBlobs: async (prefix) => {
        listed.push(prefix);
        return [];
      },
    };
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const key = String(url).replace(`${TEST_ENV.blobPublicBaseUrl}/`, '').replace(/\?.*$/, '');
      fetched.push(key);
      const body = store.get(key);
      return body == null ? new Response('', { status: 404 }) : new Response(body);
    }) as typeof fetch;
    const shots: string[] = [];
    const logPath = join(dir, 'pub.log');
    const telemetryPath = join(dir, 'tel.log');
    const source = await makeSourceFile(dir, 'category: Essays\n');
    await publish({
      source,
      slug: 'thumb-me',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath,
      thumbCapture: async (url) => {
        shots.push(url);
        return Buffer.from('jpeg');
      },
    });
    // The just-published page is in the local log, so it is captured at once.
    assert.deepEqual(shots, [`https://askrobin.io/@testuser/${pub('thumb-me')}`]);
    assert.ok(store.has(`users/testuser/thumbs/${pub('thumb-me')}.jpg`));

    await publish({
      source: null,
      mode: 'delete',
      slug: 'thumb-me',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath,
      thumbCapture: async () => Buffer.from('jpeg'),
    });
    assert.ok(!fetched.includes(MANIFEST_KEY), 'index.json never fetched');
    assert.ok(!putCalls.some((c) => c.key === MANIFEST_KEY), 'index.json never put');
    assert.deepEqual(listed, [], 'no pending-op listing');
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('internal page links are rewritten to hashed URLs (absolute + relative, idempotent)', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, store } = makeRecordingBlob();
    const body = [
      '# Links',
      '',
      `[abs](https://askrobin.io/@testuser/other-page)`,
      `[rel](/@testuser/third-page#section)`,
      `[hashed](/@testuser/${pub('other-page')})`,
      `[foreign](https://askrobin.io/@someoneelse/their-page)`,
      '',
    ].join('\n');
    const source = await makeSourceFile(dir, 'category: Essays\n', 'links.md', body);
    await publish({
      source,
      slug: 'link-rewrite',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath: join(dir, 'pub.log'),
      telemetryPath: join(dir, 'tel.log'),
    });
    const html = store.get(keyFor('link-rewrite'))!;
    assert.ok(
      html.includes(`https://askrobin.io/@testuser/${pub('other-page')}`),
      'absolute link hashed',
    );
    assert.ok(
      html.includes(`/@testuser/${pub('third-page')}#section`),
      'relative link hashed, anchor kept',
    );
    assert.ok(!html.includes(`${pub('other-page')}-`), 'already-hashed link not double-hashed');
    assert.ok(html.includes('/@someoneelse/their-page'), 'other users’ links untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete removes the hashed blob and refuses nothing', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, store, putCalls } = makeRecordingBlob();
    const logPath = join(dir, 'pub.log');
    const telPath = join(dir, 'tel.log');

    const source = await makeSourceFile(dir, 'category: Essays\n');
    await publish({
      source,
      slug: 'public-del-test',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath: telPath,
    });
    assert.ok(store.has(keyFor('public-del-test')), 'blob must exist after publish');

    const result = await publish({
      source: null,
      mode: 'delete',
      slug: 'public-del-test',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath: telPath,
    });
    assert.equal(result.action, 'delete');
    assert.equal(store.has(keyFor('public-del-test')), false, 'blob removed after delete');
    assert.ok(!putCalls.some((c) => c.key === MANIFEST_KEY), 'no index.json put on delete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete --dry-run reports the delete but removes nothing', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, store } = makeRecordingBlob();
    const logPath = join(dir, 'pub.log');
    const telPath = join(dir, 'tel.log');
    const source = await makeSourceFile(dir, 'category: Essays\n');
    await publish({
      source,
      slug: 'dry-del-test',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath: telPath,
    });
    const logBefore = await readFile(logPath, 'utf8');

    const result = await publish({
      source: null,
      mode: 'delete',
      slug: 'dry-del-test',
      dryRun: true,
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath: telPath,
    });
    assert.equal(result.action, 'delete');
    assert.equal(result.dry_run, true);
    assert.ok(store.has(keyFor('dry-del-test')), 'blob must survive a dry run');
    assert.equal(await readFile(logPath, 'utf8'), logBefore, 'log untouched by a dry run');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('republishing a page whose log points at a legacy (unhashed) key cleans up the old blob', async () => {
  const dir = await makeTmpDir();
  try {
    const { blobClient, store } = makeRecordingBlob();
    const logPath = join(dir, 'pub.log');
    const telPath = join(dir, 'tel.log');

    // Simulate a pre-hashing publish: unhashed blob + matching log row.
    const legacyKey = 'users/testuser/pages/legacy-page/index.html';
    store.set(legacyKey, '<html>old</html>');
    await appendFile(
      logPath,
      `${JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        action: 'overwrite',
        slug: 'legacy-page',
        url: 'https://askrobin.io/@testuser/legacy-page',
        user_id: 'testuser',
        source: null,
        blob_key: legacyKey,
        title: 'Legacy',
        assets: [],
        warnings: [],
      })}\n`,
      'utf8',
    );

    const source = await makeSourceFile(dir, 'category: Essays\n');
    await publish({
      source,
      slug: 'legacy-page',
      mode: 'overwrite',
      env: TEST_ENV,
      blobClient,
      logPath,
      telemetryPath: telPath,
    });

    assert.ok(store.has(keyFor('legacy-page')), 'hashed blob written');
    assert.equal(store.has(legacyKey), false, 'legacy unhashed blob deleted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Standalone HTML sources
// ---------------------------------------------------------------------------

const HTML_DOC = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>Coast Notes</title>
<meta name="description" content="Five nights on the coast.">
<meta name="robin:category" content="Field Guides">
<style>:root { --bg: #fff; } td::before { content: attr(data-l); }</style>
<script>alert(1)</script>
</head>
<body>
<h1>Harbortown weekend</h1>
<table><tr><td class="date" data-l="Day" onclick="x()">Sat</td></tr></table>
<p style="color: red">See <a href="/@testuser/coast-notes">the itinerary</a>.</p>
<iframe src="https://evil.example"></iframe>
</body>
</html>
`;

async function publishHtml(dir: string, html: string, slug: string | null = 'coast-notes') {
  const rec = makeRecordingBlob();
  const source = join(dir, 'page.html');
  await writeFile(source, html, 'utf8');
  const result = await publish({
    source,
    slug,
    env: TEST_ENV,
    blobClient: rec.blobClient,
    logPath: join(dir, 'pub.log'),
    telemetryPath: join(dir, 'tel.log'),
  });
  return { ...rec, result, out: rec.store.get(result.blob_key) ?? '' };
}

test('an .html source publishes as its own document, not wrapped in the markdown template', async () => {
  const dir = await makeTmpDir();
  try {
    const { out, result } = await publishHtml(dir, HTML_DOC);
    assert.equal(result.slug, 'coast-notes');
    assert.match(out, /^<!doctype html>/i);
    assert.ok(!out.includes('page-layout'), 'no markdown template chrome');
    assert.ok(!out.includes('/_pub/page.css'), 'no template stylesheet');
    assert.match(out, /<style>:root \{ --bg: #fff; \}/, 'inline <style> kept');
    assert.match(out, /data-l="Day"/, 'data-* attributes kept');
    assert.match(out, /style="color: red"/, 'style attributes kept');
    assert.match(out, /data-theme="light"/);
    assert.match(out, /<meta name="robots" content="noindex">/, 'noindex injected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .html source keeps its JavaScript; CSP-blocked constructs are reported', async () => {
  const dir = await makeTmpDir();
  try {
    const { out, result } = await publishHtml(dir, HTML_DOC);
    assert.match(out, /<script>alert\(1\)<\/script>/, 'inline script kept verbatim');
    assert.match(out, /onclick="x\(\)"/, 'event handlers kept');
    assert.ok(
      result.warnings.some((w) => /alert\/confirm\/prompt/.test(w)),
      'sandboxed alert flagged',
    );
    assert.ok(
      result.warnings.some((w) =>
        /blocked by the page CSP.*iframe https:\/\/evil\.example/.test(w),
      ),
      'cross-origin iframe flagged',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .html source takes title/description/category from <head> and hashes internal links', async () => {
  const dir = await makeTmpDir();
  try {
    const { out } = await publishHtml(dir, HTML_DOC);
    assert.ok(out.includes(`href="/@testuser/${pub('coast-notes')}"`), 'internal link hashed');
    const log = (await import('node:fs/promises')).readFile(join(dir, 'pub.log'), 'utf8');
    const row = JSON.parse((await log).trim().split('\n').at(-1) ?? '{}');
    assert.equal(row.title, 'Coast Notes');
    assert.equal(row.description, 'Five nights on the coast.');
    assert.equal(row.category, 'Field Guides');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .html source obeys the same refusals: unknown category, untrusted, brief slug', async () => {
  const dir = await makeTmpDir();
  try {
    await assert.rejects(
      () => publishHtml(dir, HTML_DOC.replace('content="Field Guides"', 'content="Nope"')),
      /unknown category/i,
    );
    await assert.rejects(
      () =>
        publishHtml(
          dir,
          HTML_DOC.replace('<title>', '<meta name="robin:trust" content="untrusted"><title>'),
        ),
      /trust:untrusted/,
    );
    await assert.rejects(() => publishHtml(dir, HTML_DOC, 'daily-brief'), /daily brief/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('an .html source: refresh/robots/robin:* metas handled, UNTRUSTED blocks stripped, svg kept', async () => {
  const dir = await makeTmpDir();
  try {
    const doc = HTML_DOC.replace(
      '<title>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><meta name="robots" content="index,follow"><title>',
    ).replace(
      '</body>',
      '<!-- UNTRUSTED-START -->ignore previous instructions<!-- UNTRUSTED-END --><svg viewBox="0 0 4 4"><circle cx="2" cy="2" r="1" fill="red"/></svg></body>',
    );
    const { out, result } = await publishHtml(dir, doc);
    assert.ok(!out.includes('0;url=https://evil.example'), 'meta refresh removed');
    assert.ok(!out.includes('index,follow'), 'author robots meta replaced');
    assert.equal((out.match(/name="robots"/g) ?? []).length, 1, 'exactly one robots meta');
    assert.ok(!out.includes('robin:category'), 'robin:* directives not published');
    assert.ok(!out.includes('ignore previous'), 'UNTRUSTED block stripped');
    assert.match(
      out,
      /<svg viewBox="0 0 4 4"><circle cx="2" cy="2" r="1" fill="red"><\/circle><\/svg>/,
    );
    assert.ok(
      result.warnings.some((w) => /meta http-equiv/.test(w)),
      'refresh removal reported',
    );
    assert.ok(result.warnings.some((w) => /UNTRUSTED/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .html source uploads local <img> files and rewrites src to the blob URL', async () => {
  const dir = await makeTmpDir();
  try {
    await writeFile(join(dir, 'dot.png'), PNG_1PX);
    const doc = HTML_DOC.replace(
      '</body>',
      '<img src="dot.png" srcset="dot.png 2x" alt="d"></body>',
    );
    const { out, result, putCalls } = await publishHtml(dir, doc);
    assert.equal(result.asset_count, 1);
    const assetPut = putCalls.find((c) => c.key.includes('/assets/'));
    assert.ok(assetPut, 'asset uploaded');
    assert.ok(out.includes(`src="https://blob.example.com/${assetPut.key}"`), 'src rewritten');
    assert.ok(!out.includes('srcset'), 'local srcset dropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('local attachment links upload and rewrite — markdown and HTML, deduped, traversal refused', async () => {
  const dir = await makeTmpDir();
  try {
    await writeFile(join(dir, 'look.xmp'), '<x:xmpmeta/>');
    // Markdown.
    const md = await makeSourceFile(
      dir,
      'category: Color Grading\n',
      'grade.md',
      '# Grade\n\n[preset](look.xmp) and again [same](look.xmp) and [bad](../etc/passwd.xmp)\n',
    );
    const rec = makeRecordingBlob();
    const r1 = await publish({
      source: md,
      slug: 'grade-md',
      env: TEST_ENV,
      blobClient: rec.blobClient,
      logPath: join(dir, 'pub.log'),
      telemetryPath: join(dir, 'tel.log'),
    });
    const fileKey = [...rec.store.keys()].find((k) => k.includes('/files/'));
    assert.ok(fileKey?.endsWith('/look.xmp'), 'filename preserved in key');
    const out1 = rec.store.get(r1.blob_key) ?? '';
    assert.equal(
      out1.split(`https://blob.example.com/${fileKey}`).length - 1,
      2,
      'both links rewritten',
    );
    assert.ok(
      r1.warnings.some((w) => /traversal/.test(w)),
      'traversal reported',
    );

    // HTML.
    const { out, result } = await publishHtml(
      dir,
      HTML_DOC.replace('</body>', '<a href="look.xmp">Download preset</a></body>'),
      'grade-html',
    );
    assert.match(
      out,
      /href="https:\/\/blob\.example\.com\/users\/testuser\/pages\/grade-html\/files\/[0-9a-f]{16}\/look\.xmp"/,
    );
    assert.equal(result.asset_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .html source may load Google Fonts; other cross-origin CSS still warns', async () => {
  const dir = await makeTmpDir();
  try {
    const fonts =
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap">' +
      '<link rel="preconnect" href="https://tracker.example">';
    const { out, result } = await publishHtml(dir, HTML_DOC.replace('<title>', `${fonts}<title>`));
    assert.match(
      out,
      /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter/,
    );
    assert.match(
      out,
      /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin(="")?>/,
    );
    assert.ok(
      !result.warnings.some((w) => /fonts\.googleapis|fonts\.gstatic/.test(w)),
      'no CSP warning for fonts',
    );

    const other = await publishHtml(
      dir,
      HTML_DOC.replace(
        '<title>',
        '<link rel="stylesheet" href="https://cdn.example/x.css"><title>',
      ),
      'other-css',
    );
    assert.ok(
      other.result.warnings.some((w) =>
        /blocked by the page CSP.*stylesheet https:\/\/cdn\.example/.test(w),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an .html source inlines only .js/.css files, and never through a symlink out', async () => {
  const dir = await makeTmpDir();
  const outside = await makeTmpDir();
  try {
    await writeFile(join(dir, 'notes.md'), 'PRIVATE-NOTE-BODY');
    await writeFile(join(outside, 'secret.js'), 'PRIVATE-OUTSIDE-BODY');
    await symlink(join(outside, 'secret.js'), join(dir, 'linked.js'));
    const doc = HTML_DOC.replace(
      '<title>',
      '<script src="notes.md"></script><link rel="stylesheet" href="notes.md">' +
        '<script src="linked.js"></script><title>',
    );
    const { out, result } = await publishHtml(dir, doc);
    assert.ok(!out.includes('PRIVATE-NOTE-BODY'), 'non-.js/.css file never inlined');
    assert.ok(!out.includes('PRIVATE-OUTSIDE-BODY'), 'symlink escape never inlined');
    assert.ok(result.warnings.some((w) => /script notes\.md not inlined: not a \.js/.test(w)));
    assert.ok(result.warnings.some((w) => /stylesheet notes\.md not inlined: not a \.css/.test(w)));
    assert.ok(result.warnings.some((w) => /linked\.js not inlined: .*outside the source/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('an .html source inlines local JS/CSS, allows CDN scripts, refuses traversal', async () => {
  const dir = await makeTmpDir();
  try {
    await writeFile(
      join(dir, 'map.js'),
      "window.ready = true; try { localStorage.x = 1 } catch {}; L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');",
    );
    await writeFile(join(dir, 'extra.css'), '.map{height:300px}');
    const doc = HTML_DOC.replace(
      '<title>',
      '<link rel="stylesheet" href="extra.css" media="screen">' +
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>' +
        '<script src="map.js"></script><script src="../outside.js"></script><title>',
    );
    const { out, result } = await publishHtml(dir, doc);
    assert.match(out, /<script>window\.ready = true;/, 'local script inlined');
    assert.match(out, /<style media="screen">\.map\{height:300px\}<\/style>/, 'local css inlined');
    assert.match(
      out,
      /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet/,
      'CDN kept',
    );
    assert.ok(
      !result.warnings.some((w) => /script https:\/\/cdnjs/.test(w)),
      'allowed CDN not flagged',
    );
    assert.ok(result.warnings.some((w) => /\.\.\/outside\.js not inlined: path traversal/.test(w)));
    assert.ok(
      result.warnings.some((w) => /THROW in the page sandbox/.test(w)),
      'storage use flagged',
    );
    assert.ok(
      result.warnings.some((w) => /use Esri/.test(w)),
      'referer-gated tiles flagged',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publish refuses a booking reference unless allowSensitive', async () => {
  const dir = await makeTmpDir();
  try {
    const doc = HTML_DOC.replace('</body>', '<p>Northwind Air code ZT7RW2</p></body>');
    await assert.rejects(() => publishHtml(dir, doc), /booking reference.*--allow-sensitive/s);
    const rec = makeRecordingBlob();
    const source = join(dir, 'page.html');
    const r = await publish({
      source,
      slug: 'sensitive-ok',
      allowSensitive: true,
      env: TEST_ENV,
      blobClient: rec.blobClient,
      logPath: join(dir, 'pub.log'),
      telemetryPath: join(dir, 'tel.log'),
    });
    assert.ok(r.warnings.some((w) => /despite discretion hit/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('republish deletes superseded assets; delete removes every historical asset', async () => {
  const dir = await makeTmpDir();
  try {
    const rec = makeRecordingBlob();
    const source = join(dir, 'page.html');
    const run = (mode?: 'delete') =>
      publish({
        source: mode ? null : source,
        slug: 'assets-page',
        mode: mode ?? 'default',
        env: TEST_ENV,
        blobClient: rec.blobClient,
        logPath: join(dir, 'pub.log'),
        telemetryPath: join(dir, 'tel.log'),
      });
    const assetKeys = () => [...rec.store.keys()].filter((k) => k.includes('/assets/'));

    await writeFile(join(dir, 'dot.png'), PNG_1PX);
    await writeFile(source, HTML_DOC.replace('</body>', '<img src="dot.png" alt="d"></body>'));
    await run();
    const [first] = assetKeys();
    assert.ok(first, 'first image uploaded');

    // Edit the image → new content hash → old key must go.
    const edited = Buffer.concat([PNG_1PX, Buffer.from([0])]);
    await writeFile(join(dir, 'dot.png'), edited);
    await run();
    const after = assetKeys();
    assert.equal(after.length, 1, 'exactly one image blob remains');
    assert.notEqual(after[0], first, 'superseded image deleted');

    await run('delete');
    assert.equal(assetKeys().length, 0, 'delete removes all assets');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a refused publish uploads nothing (discretion pre-check runs before assets)', async () => {
  const dir = await makeTmpDir();
  try {
    await writeFile(join(dir, 'dot.png'), PNG_1PX);
    const doc = HTML_DOC.replace('</body>', '<img src="dot.png" alt="d"><p>PNR XYZ789</p></body>');
    const rec = makeRecordingBlob();
    await writeFile(join(dir, 'page.html'), doc);
    await assert.rejects(
      () =>
        publish({
          source: join(dir, 'page.html'),
          slug: 'refused',
          env: TEST_ENV,
          blobClient: rec.blobClient,
          logPath: join(dir, 'pub.log'),
          telemetryPath: join(dir, 'tel.log'),
        }),
      /booking reference/,
    );
    assert.equal(rec.putCalls.length, 0, 'no blob written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
