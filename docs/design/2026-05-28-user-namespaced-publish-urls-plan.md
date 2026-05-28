# User-Namespaced Publish URLs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move askrobin.io publishing from flat `/p/<slug>` to user-namespaced `/@<user>/<slug>`, with a per-user index at `/@<user>/`.

**Architecture:** Robin's publish pipeline (robin-assistant-v3) emits `/@<userId>/<slug>` URLs and maintains a per-user `users/<userId>/index.json` manifest on Vercel Blob. The askrobin.io web app serves pages and the index from internal `/u/[user]/...` routes; `proxy.ts` rewrites the public `/@user/...` URL to the internal route (raw-string match, no path-to-regexp `@` ambiguity) and redirects the internal path back to canonical. `kevin` → `iser` rename with a one-off blob migration; `/p/` removed last.

**Tech Stack:** TypeScript, Node (node:test) on the pipeline; Next.js 16 App Router + Vitest on askrobin.io; `@vercel/blob` (`copy`, `list`, `put`).

**Deviation from spec:** spec §1 proposed a `next.config` rewrite with middleware as fallback. Implementation uses `proxy.ts` (the app's existing routing dispatcher) as the **primary** rewrite home — it matches raw pathnames so the `@` sigil needs no path-to-regexp support, and it's where all other askrobin.io routing already lives.

---

## File Structure

**robin-assistant-v3:**
- Modify `system/lib/publish/orchestrate.ts` — replace 4 `/p/${slug}` sites with a `pageUrl()` helper; call manifest writer after publish & delete.
- Create `system/lib/publish/manifest.ts` — `ManifestEntry` type, `buildManifest()` pure reducer, `writeManifest()` blob writer.
- Create `system/lib/publish/manifest.test.ts` — reducer unit tests.
- Modify `system/lib/publish/orchestrate.test.ts` (and any test asserting `/p/`) — expect `/@<user>/`.
- Modify `docs/PUBLISHING.md`, `CLAUDE.md` — URL scheme.

**askrobin.io:**
- Create `apps/web/app/u/[user]/[slug]/route.ts` — page serve (validated, fail-closed).
- Create `apps/web/app/u/[user]/route.ts` — index render (HTML-escaped).
- Create `apps/web/lib/publish-serve.ts` — shared helpers (`USER_RE`, `SLUG_RE`, `SECURITY_HEADERS`, `escapeHtml`, `decodeAndValidate`).
- Create `apps/web/lib/publish-serve.test.ts` — validation + escaping unit tests.
- Modify `apps/web/proxy.ts` — `/@user/...` → `/u/user/...` rewrite + `/u/...` → `/@...` redirect.
- Delete `apps/web/app/p/[slug]/route.ts` (final cutover task).

**One-off (not committed to package):**
- `user-data/scripts/migrate-publish-iser.ts` — paginated blob copy + manifest build + log rewrite. Removed after running.

---

## Phase 1 — Pipeline: URL scheme + manifest (robin-assistant-v3)

### Task 1: `pageUrl()` helper and `/p/` → `/@user/` replacement

**Files:**
- Modify: `system/lib/publish/orchestrate.ts` (4 URL sites: ~252, 333, 356, 382)
- Test: `system/lib/publish/orchestrate.test.ts`

- [ ] **Step 1: Write/extend a failing test asserting the new URL shape**

In `orchestrate.test.ts`, add (or adapt the existing publish-result assertion):

```ts
test('publish result URL uses /@<user>/<slug>', async () => {
  const res = await runPublish(makeOpts({ slug: 'hello', userId: 'iser' }));
  assert.equal(res.url, 'https://askrobin.io/@iser/hello');
});
```

(Use the file's existing `makeOpts`/harness; if the harness hardcodes a userId, set it to `iser`.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `pnpm exec tsx --test system/lib/publish/orchestrate.test.ts`
Expected: FAIL — actual url is `https://askrobin.io/p/hello`.

- [ ] **Step 3: Add the helper and replace all 4 sites**

Near the top of `orchestrate.ts` (after imports), add:

```ts
/** Canonical public URL for a published page. */
function pageUrl(env: PublishEnv, slug: string): string {
  return `${env.publicUrl}/@${env.userId}/${slug}`;
}
```

Replace each occurrence of `` `${opts.env.publicUrl}/p/${slug}` `` and `` `${input.env.publicUrl}/p/${slug}` `` with `pageUrl(opts.env, slug)` / `pageUrl(input.env, slug)` respectively (4 sites: publish resultBase ~252, delete noop ~333, delete log ~356, delete result ~382).

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm exec tsx --test system/lib/publish/orchestrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/lib/publish/orchestrate.ts system/lib/publish/orchestrate.test.ts
git commit -m "feat(publish): emit /@<user>/<slug> page URLs"
```

### Task 2: Manifest reducer (pure function — the core unit)

**Files:**
- Create: `system/lib/publish/manifest.ts`
- Test: `system/lib/publish/manifest.test.ts`

- [ ] **Step 1: Write failing tests**

`system/lib/publish/manifest.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogRow } from './types.ts';
import { buildManifest } from './manifest.ts';

const row = (o: Partial<LogRow>): LogRow => ({
  ts: '2026-05-01T00:00:00.000Z', action: 'overwrite', slug: 's', url: 'x',
  user_id: 'iser', source: null, blob_key: 'k', title: 'T', assets: [], warnings: [], ...o,
});

test('buildManifest: title from latest, published=earliest, updated=latest, url recomputed', () => {
  const entries: LogRow[] = [
    row({ slug: 'a', ts: '2026-05-01T00:00:00.000Z', title: 'Old', url: 'https://x/p/a' }),
    row({ slug: 'a', ts: '2026-05-03T00:00:00.000Z', title: 'New', url: 'https://x/p/a' }),
  ];
  const m = buildManifest(entries, { publicUrl: 'https://askrobin.io', userId: 'iser' });
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], {
    slug: 'a', title: 'New',
    url: 'https://askrobin.io/@iser/a',
    published_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-03T00:00:00.000Z',
  });
});

test('buildManifest: drops slugs whose latest action is delete', () => {
  const entries: LogRow[] = [
    row({ slug: 'b', ts: '2026-05-01T00:00:00.000Z', action: 'overwrite' }),
    row({ slug: 'b', ts: '2026-05-02T00:00:00.000Z', action: 'delete' }),
  ];
  assert.equal(buildManifest(entries, { publicUrl: 'https://askrobin.io', userId: 'iser' }).length, 0);
});

test('buildManifest: re-published after delete is included', () => {
  const entries: LogRow[] = [
    row({ slug: 'c', ts: '2026-05-01T00:00:00.000Z', action: 'overwrite' }),
    row({ slug: 'c', ts: '2026-05-02T00:00:00.000Z', action: 'delete' }),
    row({ slug: 'c', ts: '2026-05-03T00:00:00.000Z', action: 'overwrite', title: 'Back' }),
  ];
  const m = buildManifest(entries, { publicUrl: 'https://askrobin.io', userId: 'iser' });
  assert.equal(m.length, 1);
  assert.equal(m[0].title, 'Back');
});

test('buildManifest: sorted newest-first by updated_at; empty input → []', () => {
  assert.deepEqual(buildManifest([], { publicUrl: 'https://x', userId: 'iser' }), []);
  const m = buildManifest([
    row({ slug: 'old', ts: '2026-05-01T00:00:00.000Z' }),
    row({ slug: 'new', ts: '2026-05-09T00:00:00.000Z' }),
  ], { publicUrl: 'https://x', userId: 'iser' });
  assert.deepEqual(m.map((e) => e.slug), ['new', 'old']);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm exec tsx --test system/lib/publish/manifest.test.ts`
Expected: FAIL — `manifest.ts` not found.

- [ ] **Step 3: Implement `manifest.ts` (reducer only for now)**

```ts
import type { BlobClient, LogRow } from './types.ts';

export interface ManifestEntry {
  slug: string;
  title: string | null;
  url: string;
  published_at: string;
  updated_at: string;
}

/**
 * Fold the LogRow log into one entry per live slug. Treats all rows as the
 * current publisher's (single-publisher assumption). url is recomputed from
 * env so historical /p/ urls never leak. Slugs whose latest action is `delete`
 * are dropped. Sorted newest-first by updated_at.
 */
export function buildManifest(
  entries: LogRow[],
  env: { publicUrl: string; userId: string },
): ManifestEntry[] {
  const bySlug = new Map<string, { firstTs: string; lastTs: string; lastAction: string; title: string | null }>();
  for (const e of entries) {
    const cur = bySlug.get(e.slug);
    if (!cur) {
      bySlug.set(e.slug, { firstTs: e.ts, lastTs: e.ts, lastAction: e.action, title: e.title });
    } else {
      if (e.ts < cur.firstTs) cur.firstTs = e.ts;
      if (e.ts >= cur.lastTs) { cur.lastTs = e.ts; cur.lastAction = e.action; cur.title = e.title; }
    }
  }
  const out: ManifestEntry[] = [];
  for (const [slug, v] of bySlug) {
    if (v.lastAction === 'delete') continue;
    out.push({
      slug,
      title: v.title,
      url: `${env.publicUrl}/@${env.userId}/${slug}`,
      published_at: v.firstTs,
      updated_at: v.lastTs,
    });
  }
  out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return out;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm exec tsx --test system/lib/publish/manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add system/lib/publish/manifest.ts system/lib/publish/manifest.test.ts
git commit -m "feat(publish): manifest reducer for per-user page index"
```

### Task 3: Manifest writer + wire into publish & delete

**Files:**
- Modify: `system/lib/publish/manifest.ts` (add `writeManifest`)
- Modify: `system/lib/publish/orchestrate.ts` (call after publish log append ~284 and delete log append ~366)
- Test: `system/lib/publish/manifest.test.ts`

- [ ] **Step 1: Write failing test for `writeManifest`**

Append to `manifest.test.ts`:

```ts
test('writeManifest: PUTs users/<userId>/index.json with manifest JSON', async () => {
  const puts: Array<{ key: string; body: string }> = [];
  const blob = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key: string, body: string | Buffer) => { puts.push({ key, body: String(body) }); return { url: 'u' }; },
    delBlob: async () => {},
  };
  await writeManifest(blob as any, { publicUrl: 'https://askrobin.io', userId: 'iser' },
    [row({ slug: 'a', ts: '2026-05-01T00:00:00.000Z', title: 'A' })]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, 'users/iser/index.json');
  const parsed = JSON.parse(puts[0].body);
  assert.equal(parsed[0].slug, 'a');
  assert.equal(parsed[0].url, 'https://askrobin.io/@iser/a');
});
```

Add `writeManifest` to the import line in the test.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm exec tsx --test system/lib/publish/manifest.test.ts`
Expected: FAIL — `writeManifest` not exported.

- [ ] **Step 3: Implement `writeManifest`**

Add to `manifest.ts`:

```ts
import { HTML_CACHE_MAX_AGE } from './config.ts';

/** Build and PUT the per-user manifest to blob. Caller wraps in try/catch. */
export async function writeManifest(
  blob: BlobClient,
  env: { publicUrl: string; userId: string },
  entries: LogRow[],
): Promise<void> {
  const manifest = buildManifest(entries, env);
  await blob.putBlob(`users/${env.userId}/index.json`, JSON.stringify(manifest), {
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: true,
  });
}
```

- [ ] **Step 4: Wire into orchestrate.ts — publish path**

In `runPublish`, immediately AFTER the `appendLogEntry(opts.logPath, logRow)` try/catch (~line 284), add:

```ts
try {
  const { entries } = await readLog(opts.logPath);
  await writeManifest(opts.blobClient, opts.env, entries);
} catch (err) {
  warnings.push(`manifest write failed: ${(err as Error).message}`);
}
```

In `runDelete`, AFTER the delete log append try/catch (~line 366), add:

```ts
try {
  const { entries } = await readLog(input.logPath);
  await writeManifest(input.blobClient, input.env, entries);
} catch {
  // best-effort; next publish repairs it
}
```

Add `writeManifest` to the `manifest.ts` import in orchestrate.ts. (`readLog` is already imported.)

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm exec tsx --test system/lib/publish/manifest.test.ts system/lib/publish/orchestrate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add system/lib/publish/manifest.ts system/lib/publish/manifest.test.ts system/lib/publish/orchestrate.ts
git commit -m "feat(publish): write per-user manifest on publish and delete"
```

### Task 4: Sweep remaining `/p/` test assertions

**Files:** Modify any pipeline test asserting `/p/`.

- [ ] **Step 1:** `grep -rn "/p/" system/lib/publish/*.test.ts` — update each expected URL to `/@<user>/<slug>` using the test's userId.
- [ ] **Step 2:** Run `pnpm exec tsx --test system/lib/publish/*.test.ts` — expect all PASS.
- [ ] **Step 3:** `pnpm typecheck` — expect clean.
- [ ] **Step 4: Commit**

```bash
git add system/lib/publish
git commit -m "test(publish): update URL assertions to /@<user>/<slug>"
```

---

## Phase 2 — Web: internal routes + proxy rewrite (askrobin.io)

> Work in `~/workspace/robin/askrobin.io`. Keep `app/p/[slug]/route.ts` intact through this phase.

### Task 5: Shared serve helpers

**Files:**
- Create: `apps/web/lib/publish-serve.ts`
- Test: `apps/web/lib/publish-serve.test.ts`

- [ ] **Step 1: Write failing tests**

`apps/web/lib/publish-serve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeAndValidateUser, escapeHtml, SLUG_RE } from './publish-serve';

describe('decodeAndValidateUser', () => {
  it('accepts a normal handle, lowercased', () => {
    expect(decodeAndValidateUser('iser')).toBe('iser');
    expect(decodeAndValidateUser('Iser')).toBe('iser');
  });
  it('rejects traversal, slashes, encoded slashes, empty', () => {
    for (const bad of ['', '..', 'a/b', 'a%2Fb', '%2e%2e', 'a..b', 'has space']) {
      expect(decodeAndValidateUser(bad)).toBeNull();
    }
  });
});

describe('escapeHtml', () => {
  it('escapes XSS in titles', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`"a"&'b'`)).toBe('&quot;a&quot;&amp;&#39;b&#39;');
  });
});

describe('SLUG_RE', () => {
  it('accepts valid slugs, rejects bad', () => {
    expect(SLUG_RE.test('color-grade-assistant')).toBe(true);
    expect(SLUG_RE.test('../etc')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter web test publish-serve` (or `cd apps/web && pnpm test publish-serve`)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `publish-serve.ts`**

```ts
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const USER_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", 'img-src https: data:', "style-src 'self' 'unsafe-inline'",
    "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
    "base-uri 'self'", "form-action 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** Decode (once) and validate a user handle. Returns the normalized handle or
 * null. Fail-closed: anything with traversal/slash/space → null (no fetch). */
export function decodeAndValidateUser(raw: string): string | null {
  let s: string;
  try { s = decodeURIComponent(raw); } catch { return null; }
  if (s.includes('/') || s.includes('..')) return null;
  s = s.toLowerCase();
  return USER_RE.test(s) ? s : null;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/web && pnpm test publish-serve`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/publish-serve.ts apps/web/lib/publish-serve.test.ts
git commit -m "feat(publish): shared serve helpers (validation, escaping)"
```

### Task 6: Page serve route `/u/[user]/[slug]`

**Files:**
- Create: `apps/web/app/u/[user]/[slug]/route.ts`

- [ ] **Step 1: Implement the route** (adapted from `app/p/[slug]/route.ts`)

```ts
import { decodeAndValidateUser, SECURITY_HEADERS, SLUG_RE } from '../../../../lib/publish-serve';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ user: string; slug: string }> },
) {
  const { user: rawUser, slug } = await params;
  const user = decodeAndValidateUser(rawUser);
  if (!user || !SLUG_RE.test(slug)) return notFound();

  const blobBase = process.env.BLOB_PUBLIC_BASE_URL;
  if (!blobBase) return temporarilyUnavailable();

  const upstream = await fetch(`${blobBase}/users/${user}/pages/${slug}/index.html`, { cache: 'no-store' });
  if (upstream.status === 404) return notFound();
  if (!upstream.ok) return temporarilyUnavailable();

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60, must-revalidate',
      ...SECURITY_HEADERS,
    },
  });
}

function notFound() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><link rel="stylesheet" href="/_pub/page.css"></head><body><main class="prose"><h1>Not found</h1><p>No published page at this URL.</p></main></body></html>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', ...SECURITY_HEADERS } },
  );
}
function temporarilyUnavailable() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Temporarily unavailable</title><link rel="stylesheet" href="/_pub/page.css"></head><body><main class="prose"><h1>Temporarily unavailable</h1><p>Please refresh in a moment.</p></main></body></html>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS } },
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: clean (note `typedRoutes: true` — this is a route handler, not a `<Link>`, so no typed-route entry needed).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/u/[user]/[slug]/route.ts
git commit -m "feat(publish): /u/[user]/[slug] page serve route"
```

### Task 7: Index route `/u/[user]`

**Files:**
- Create: `apps/web/app/u/[user]/route.ts`

- [ ] **Step 1: Implement the index route**

```ts
import { decodeAndValidateUser, escapeHtml, SECURITY_HEADERS } from '../../../lib/publish-serve';

interface ManifestEntry { slug: string; title: string | null; url: string; published_at: string; updated_at: string; }

export async function GET(_req: Request, { params }: { params: Promise<{ user: string }> }) {
  const { user: rawUser } = await params;
  const user = decodeAndValidateUser(rawUser);
  if (!user) return notFound();

  const blobBase = process.env.BLOB_PUBLIC_BASE_URL;
  if (!blobBase) return unavailable();

  const res = await fetch(`${blobBase}/users/${user}/index.json`, { cache: 'no-store' });
  if (res.status === 404) return notFound();      // unknown user
  if (!res.ok) return unavailable();

  let entries: ManifestEntry[] = [];
  try { entries = await res.json(); } catch { entries = []; }

  const items = entries.length
    ? entries.map((e) => {
        const d = new Date(e.updated_at).toISOString().slice(0, 10);
        return `<li><a href="/@${escapeHtml(user)}/${escapeHtml(e.slug)}">${escapeHtml(e.title ?? e.slug)}</a> <time>${escapeHtml(d)}</time></li>`;
      }).join('')
    : '<li class="empty">Nothing published yet.</li>';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>@${escapeHtml(user)}</title><link rel="stylesheet" href="/_pub/page.css"></head><body><main class="prose"><h1>@${escapeHtml(user)}</h1><ul class="index">${items}</ul></main></body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60, must-revalidate', ...SECURITY_HEADERS },
  });
}

function notFound() {
  return new Response(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/_pub/page.css"><main class="prose"><h1>Not found</h1></main>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
}
function unavailable() {
  return new Response(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/_pub/page.css"><main class="prose"><h1>Temporarily unavailable</h1></main>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS } });
}
```

- [ ] **Step 2: Typecheck** — `cd apps/web && pnpm typecheck` → clean.
- [ ] **Step 3: Commit**

```bash
git add apps/web/app/u/[user]/route.ts
git commit -m "feat(publish): /u/[user] per-user index route (escaped)"
```

### Task 8: proxy.ts — sigil rewrite + canonical redirect

**Files:**
- Modify: `apps/web/proxy.ts`

- [ ] **Step 1: Add the apex branches**

In `proxy.ts`, BEFORE the final `return NextResponse.next();` and AFTER the subdomain dispatch block, add:

```ts
// Public user space: /@<user>/...  → internal /u/<user>/...  (apex only).
// Raw-string match on the @ sigil — no path-to-regexp involvement.
if (pathname.startsWith('/@')) {
  const rest = pathname.slice(2); // drop "/@"
  return NextResponse.rewrite(new URL(`/u/${rest}`, req.url));
}
// Canonicalize: a direct hit on the internal path redirects to the public URL.
if (pathname.startsWith('/u/')) {
  const url = req.nextUrl.clone();
  url.pathname = `/@${pathname.slice(3)}`;
  return NextResponse.redirect(url, 308);
}
```

Note: rewrite (internal) does NOT re-enter proxy path-matching for the destination in a way that loops — the `/u/...` produced by the rewrite is served directly; the redirect branch only fires for *inbound* `/u/...` requests.

- [ ] **Step 2: Build to verify proxy compiles**

Run: `cd apps/web && pnpm build` (or `pnpm typecheck`)
Expected: clean.

- [ ] **Step 3: Manual smoke (dev server)**

Run `pnpm --filter web dev`, then with a test blob present:
- `curl -sI localhost:3030/@iser/<existing-slug>` → 200, `content-type: text/html`
- `curl -sI localhost:3030/u/iser/<slug>` → 308 → `location: /@iser/<slug>`
- `curl -sI localhost:3030/@iser` → 200 (index)
- `curl -sI localhost:3030/@iser/../secret` → 404

- [ ] **Step 4: Commit**

```bash
git add apps/web/proxy.ts
git commit -m "feat(publish): proxy rewrite /@user→/u/user + canonical redirect"
```

### Task 9: Route unit tests (vitest)

**Files:** Create `apps/web/app/u/[user]/route.test.ts` (and/or for the page route) following the repo's existing route-test pattern (`app/sitemap.test.ts`).

- [ ] **Step 1:** Write tests that call the exported `GET` with a mocked `fetch` (vi.stubGlobal('fetch', ...)):
  - index: manifest with a `<script>`-titled entry → response body contains escaped `&lt;script&gt;`, not raw.
  - index: 404 manifest → 404; empty array → body contains "Nothing published yet."
  - page: `decodeAndValidateUser` rejects `..` → 404 with no fetch call (assert fetch not called).
- [ ] **Step 2:** Run `cd apps/web && pnpm test` → PASS.
- [ ] **Step 3: Commit**

```bash
git add apps/web/app/u
git commit -m "test(publish): user route validation + title escaping"
```

---

## Phase 3 — Migration (one-off)

### Task 10: Migrate `kevin` → `iser` blobs + build manifest

**Files:** Create `user-data/scripts/migrate-publish-iser.ts` (robin-assistant-v3; throwaway).

- [ ] **Step 1: Write the script**

```ts
import { list, copy } from '@vercel/blob';
import { readLog } from '../../system/lib/publish/log.ts';
import { buildManifest } from '../../system/lib/publish/manifest.ts';
import { put } from '@vercel/blob';

const token = process.env.BLOB_READ_WRITE_TOKEN!;
const publicUrl = process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io';
const apply = process.argv.includes('--apply');

async function main() {
  // 1. Paginate kevin's subtree → copy to iser.
  let cursor: string | undefined;
  const copied: string[] = [];
  do {
    const r = await list({ prefix: 'users/kevin/', cursor, token });
    for (const b of r.blobs) {
      const dest = b.pathname.replace(/^users\/kevin\//, 'users/iser/');
      if (apply) await copy(b.pathname, dest, { access: 'public', token });
      copied.push(`${b.pathname} -> ${dest}`);
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  console.log(`${apply ? 'copied' : 'would copy'} ${copied.length} blobs`);

  // 2. Build iser manifest from the local log (entries already rewritten to iser, see Step 2).
  const { entries } = await readLog(`${process.env.ROBIN_USER_DATA_DIR}/observability/publish/index.jsonl`);
  const manifest = buildManifest(entries, { publicUrl, userId: 'iser' });
  console.log(`manifest entries: ${manifest.length}`);
  if (apply) {
    await put('users/iser/index.json', JSON.stringify(manifest), {
      access: 'public', token, contentType: 'application/json; charset=utf-8', allowOverwrite: true,
    });
  }
}
main();
```

- [ ] **Step 2: Rewrite the local log's user_id** (so the manifest's single-publisher view is consistent):

```bash
cd ~/workspace/robin/robin-assistant-v3
sed -i '' 's/"user_id":"kevin"/"user_id":"iser"/g' user-data/observability/publish/index.jsonl
```

- [ ] **Step 3: Dry-run** — `ROBIN_USER_DATA_DIR=$(pwd)/user-data pnpm exec tsx user-data/scripts/migrate-publish-iser.ts` → review counts.
- [ ] **Step 4: Apply** — re-run with `--apply`.
- [ ] **Step 5: Verify** the iser blobs exist (the cutover in Task 11 verifies serving). Do NOT delete `users/kevin/` yet — it's the rollback copy.

---

## Phase 4 — Cutover & docs

### Task 11: Flip publisher, remove `/p/`, update docs

**Deploy order (from spec — do not reorder):** Phase 2 web routes must be **deployed** before this task flips the publisher.

- [ ] **Step 1:** In `user-data/config/secrets/.env`, set `PUBLISH_USER_ID=iser` (was `kevin`). Restart daemon: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`.
- [ ] **Step 2:** Verify live: `curl -sI https://askrobin.io/@iser/color-grade-assistant` → 200; `https://askrobin.io/@iser` → 200 index listing it.
- [ ] **Step 3:** Remove the old route and drop the web serve path's reliance on `PUBLISH_DEFAULT_USER_ID`:

```bash
cd ~/workspace/robin/askrobin.io
git rm apps/web/app/p/[slug]/route.ts
```

(Confirm nothing else imports `PUBLISH_DEFAULT_USER_ID`: `grep -rn PUBLISH_DEFAULT_USER_ID apps/web` — remove dead reads.)

- [ ] **Step 4:** Verify `curl -sI https://askrobin.io/p/color-grade-assistant` → 404.
- [ ] **Step 5: Update docs** (prevent rot):
  - `robin-assistant-v3/docs/PUBLISHING.md` — `/p/<slug>` → `/@<user>/<slug>` + index.
  - `robin-assistant-v3/CLAUDE.md` — publish-pipeline paragraph ("served at askrobin.io/p/<slug>", route handler path).
  - any askrobin.io README referencing `/p/`.
- [ ] **Step 6:** After confirming iser serves for a day, delete the rollback copy: a `list({prefix:'users/kevin/'})` + `del()` loop (or via dashboard). Separate, manual, gated.
- [ ] **Step 7:** Remove the throwaway migration script: `mv user-data/scripts/migrate-publish-iser.ts ~/.Trash/`.
- [ ] **Step 8: Commit (askrobin.io + robin-assistant-v3 docs)**

```bash
# askrobin.io
git add -A && git commit -m "feat(publish): remove legacy /p/ route (superseded by /@user/)"
# robin-assistant-v3
git add docs/PUBLISHING.md CLAUDE.md && git commit -m "docs: publish URLs are now /@<user>/<slug>"
```

---

## Self-Review

**Spec coverage:** §1 routing → Tasks 6–8 (proxy rewrite supersedes next.config per the noted deviation). §2 pipeline+manifest → Tasks 1–3. §3 index render → Task 7; migration → Task 10; sequencing → Phase ordering + Task 11 note; testing → Tasks 2,5,9; docs → Task 11. Security (traversal/XSS) → Tasks 5,9. All covered.

**Placeholder scan:** none — every code/test step has concrete content.

**Type consistency:** `ManifestEntry` fields (`slug,title,url,published_at,updated_at`) identical in `manifest.ts`, the index route, and the migration. `buildManifest(entries, {publicUrl,userId})` and `writeManifest(blob, env, entries)` signatures consistent across Tasks 2/3/10. `decodeAndValidateUser`/`escapeHtml`/`SLUG_RE` defined in Task 5, used in 6/7/9.
