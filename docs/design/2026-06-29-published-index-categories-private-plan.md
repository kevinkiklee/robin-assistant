# Categorized Index + Private Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat published-pages index at `askrobin.io/@<user>/` with a categorized, searchable library view, and add truly-private pages visible only to the logged-in admin.

**Architecture:** Two phases across two repos. **Phase 1** (`robin-assistant-v3`, the publish pipeline) adds `category`/`visibility` frontmatter, validates them, writes two manifests (public + private) and stores private page HTML under a separate private-access blob prefix; a one-time script backfills the 112 existing pages. **Phase 2** (`askrobin.io`, the serving app) renders the category-rail index with client-side search/sort, gates private pages behind the existing `isAdmin` Auth.js check, and sets `no-store` on every auth-dependent response. Phase 1 ships + backfills before Phase 2; the live old index keeps working because the public manifest stays a bare JSON array.

**Tech Stack:** TypeScript, Node 24 ESM, `@vercel/blob`, `unified`/`gray-matter` (publish); Next.js 16 App Router, Auth.js v5, Vitest (askrobin). Phase-1 tests use `node:test` + `assert` (run `pnpm exec tsx --test <file>`); Phase-2 tests use Vitest.

## Global Constraints

- Spec of record: `docs/design/2026-06-29-published-index-categories-private.md`. Every task's requirements include it.
- **Taxonomy (exact, in display order):** `Lens Analysis`, `Gear & Comparisons`, `Field Guides`, `Color Grading`, `Critiques`, `Essays`, `Tools & Setup`, `Projects`. Fallback bucket: `Uncategorized` (rendered last).
- **Visibility values:** `public` (default), `private`. Any other value → reject publish.
- Unknown category → reject (`EXIT_POLICY`, code 2). Missing category → `Uncategorized` + a warning. Missing visibility → `public`.
- The public manifest `users/<u>/index.json` MUST remain a **bare JSON array of entries** (extra fields go on each entry). Private metadata MUST NOT appear in any `access:'public'` blob.
- Blob key prefixes: public page → `users/<u>/pages/<slug>/index.html`; private page → `users/<u>/private/<slug>/index.html`.
- All auth-dependent serving responses are `cache-control: private, no-store`. Confirmed-public page hits keep `public, max-age=60`.
- Preserve existing security controls verbatim: `decodeAndValidateUser`, `SLUG_RE`, HTML escaping, `REFUSED_SLUG_PATTERN` (daily-brief refusal).
- Commit after every task. Branch: `feat/published-index-categories-private` (already checked out for Phase 1; create the same-named branch in the askrobin repo for Phase 2).

---

# Phase 1 — robin-assistant-v3 (publish pipeline + backfill)

## File structure (Phase 1)

- `system/lib/publish/config.ts` *(modify)* — add `CATEGORIES`, `UNCATEGORIZED`, `VISIBILITIES`.
- `system/lib/publish/categories.ts` *(create)* — pure `classify()` of frontmatter → category/visibility/warnings.
- `system/lib/publish/categories.test.ts` *(create)*.
- `system/lib/publish/types.ts` *(modify)* — `BlobPutOptions.access`; `LogRow` + `ManifestEntry`-adjacent fields.
- `system/lib/publish/blob.ts` *(modify)* — honor `access` in `putBlob`.
- `system/lib/publish/manifest.ts` *(modify)* — carry fields; split public/private; write two manifests.
- `system/lib/publish/orchestrate.ts` *(modify)* — classify, choose blob prefix/access, log new fields, visibility-flip cleanup.
- `system/scripts/backfill-publish-categories.ts` *(create)* — one-time log backfill + pure `categoryForSlug()`.
- `system/scripts/backfill-publish-categories.test.ts` *(create)* — tests `categoryForSlug`.
- `system/lib/publish/README.md` *(create or modify)* — document the two frontmatter fields + category list.

---

### Task 1: Classification helper (`categories.ts`)

**Files:**
- Modify: `system/lib/publish/config.ts`
- Create: `system/lib/publish/categories.ts`
- Test: `system/lib/publish/categories.test.ts`

**Interfaces:**
- Produces: `CATEGORIES: readonly string[]`, `UNCATEGORIZED: string`, `VISIBILITIES: readonly string[]` (config.ts); `type Visibility = 'public' | 'private'`; `type ClassifyResult = { ok: true; category: string; visibility: Visibility; warnings: string[] } | { ok: false; error: string }`; `function classify(rawCategory: unknown, rawVisibility: unknown): ClassifyResult`.

- [ ] **Step 1: Add constants to `config.ts`**

Append to `system/lib/publish/config.ts`:

```ts
/** Fixed publish taxonomy (display order). Single source of truth. */
export const CATEGORIES = [
  'Lens Analysis',
  'Gear & Comparisons',
  'Field Guides',
  'Color Grading',
  'Critiques',
  'Essays',
  'Tools & Setup',
  'Projects',
] as const;

/** Fallback bucket for pages published without a category; rendered last. */
export const UNCATEGORIZED = 'Uncategorized';

/** Allowed `visibility` frontmatter values. */
export const VISIBILITIES = ['public', 'private'] as const;
```

- [ ] **Step 2: Write the failing test**

Create `system/lib/publish/categories.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from './categories.ts';
import { UNCATEGORIZED } from './config.ts';

test('valid category + explicit private', () => {
  const r = classify('Field Guides', 'private');
  assert.deepEqual(r, { ok: true, category: 'Field Guides', visibility: 'private', warnings: [] });
});

test('missing category → Uncategorized + warning, default public', () => {
  const r = classify(undefined, undefined);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.category, UNCATEGORIZED);
    assert.equal(r.visibility, 'public');
    assert.equal(r.warnings.length, 1);
  }
});

test('empty-string category → Uncategorized + warning', () => {
  const r = classify('', '');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.category, UNCATEGORIZED);
});

test('unknown category → reject', () => {
  const r = classify('Photograhy', undefined);
  assert.equal(r.ok, false);
});

test('invalid visibility → reject', () => {
  const r = classify('Essays', 'secret');
  assert.equal(r.ok, false);
});

test('non-string category → reject', () => {
  const r = classify(42, undefined);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec tsx --test system/lib/publish/categories.test.ts`
Expected: FAIL — `Cannot find module './categories.ts'`.

- [ ] **Step 4: Write `categories.ts`**

Create `system/lib/publish/categories.ts`:

```ts
import { CATEGORIES, UNCATEGORIZED, VISIBILITIES } from './config.ts';

export type Visibility = (typeof VISIBILITIES)[number];

export type ClassifyResult =
  | { ok: true; category: string; visibility: Visibility; warnings: string[] }
  | { ok: false; error: string };

function isBlank(v: unknown): boolean {
  return v == null || v === '';
}

/**
 * Resolve the `category` and `visibility` frontmatter values into a publish
 * classification. Pure — orchestrate.ts maps `{ok:false}` to a PublishError.
 *  - missing category  → Uncategorized + warning
 *  - unknown category  → reject
 *  - missing visibility → public
 *  - invalid visibility → reject
 */
export function classify(rawCategory: unknown, rawVisibility: unknown): ClassifyResult {
  const warnings: string[] = [];

  let category: string;
  if (isBlank(rawCategory)) {
    category = UNCATEGORIZED;
    warnings.push(`no category set — filed under "${UNCATEGORIZED}"`);
  } else if (typeof rawCategory !== 'string') {
    return { ok: false, error: `category must be a string, got ${typeof rawCategory}` };
  } else if (!(CATEGORIES as readonly string[]).includes(rawCategory)) {
    return {
      ok: false,
      error: `unknown category "${rawCategory}" — valid: ${CATEGORIES.join(', ')}`,
    };
  } else {
    category = rawCategory;
  }

  let visibility: Visibility;
  if (isBlank(rawVisibility)) {
    visibility = 'public';
  } else if (
    typeof rawVisibility === 'string' &&
    (VISIBILITIES as readonly string[]).includes(rawVisibility)
  ) {
    visibility = rawVisibility as Visibility;
  } else {
    return { ok: false, error: `invalid visibility "${String(rawVisibility)}" — valid: ${VISIBILITIES.join(', ')}` };
  }

  return { ok: true, category, visibility, warnings };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec tsx --test system/lib/publish/categories.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add system/lib/publish/config.ts system/lib/publish/categories.ts system/lib/publish/categories.test.ts
git commit -m "feat(publish): taxonomy constants + frontmatter classify() helper"
```

---

### Task 2: Blob `access` option (`blob.ts`)

**Files:**
- Modify: `system/lib/publish/types.ts` (`BlobPutOptions`)
- Modify: `system/lib/publish/blob.ts:12-23,115-135` (`PutFn`, `putBlob`)
- Test: `system/lib/publish/blob.test.ts` (add a case)

**Interfaces:**
- Produces: `BlobPutOptions.access?: 'public' | 'private'` (default `'public'`); `putBlob` forwards it to `@vercel/blob`'s `put`.

- [ ] **Step 1: Add `access` to `BlobPutOptions`**

In `system/lib/publish/types.ts`, change `BlobPutOptions`:

```ts
export interface BlobPutOptions {
  contentType?: string;
  cacheControlMaxAge?: number;
  allowOverwrite?: boolean;
  access?: 'public' | 'private';
}
```

- [ ] **Step 2: Write the failing test**

Add to `system/lib/publish/blob.test.ts` (use the file's existing mock-`putFn` pattern):

```ts
test('putBlob forwards access:private when requested', async () => {
  const calls: Array<{ access: string }> = [];
  const putFn = (async (_k: string, _b: unknown, opts: { access: string }) => {
    calls.push({ access: opts.access });
    return { url: 'https://blob/x' };
  }) as unknown as import('./blob.ts').PutFn;
  const client = createBlobClient({ token: 't', putFn });
  await client.putBlob('k', 'body', { access: 'private' });
  await client.putBlob('k2', 'body');
  assert.equal(calls[0].access, 'private');
  assert.equal(calls[1].access, 'public'); // default
});
```

(Ensure `createBlobClient` and `assert`/`test` are imported as the existing tests do.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec tsx --test system/lib/publish/blob.test.ts`
Expected: FAIL — `calls[0].access` is `'public'` (access ignored).

- [ ] **Step 4: Implement**

In `system/lib/publish/blob.ts`, widen `PutFn`'s `access` field:

```ts
export type PutFn = (
  key: string,
  body: string | Buffer,
  opts: {
    access: 'public' | 'private';
    token: string;
    contentType?: string;
    addRandomSuffix: false;
    allowOverwrite: boolean;
    cacheControlMaxAge?: number;
  },
) => Promise<{ url: string; pathname?: string }>;
```

In `putBlob`, replace the hardcoded `access: 'public'`:

```ts
        putFn(key, body, {
          access: putOpts.access ?? 'public',
          token,
          contentType: putOpts.contentType,
          addRandomSuffix: false,
          allowOverwrite: putOpts.allowOverwrite ?? false,
          ...(putOpts.cacheControlMaxAge != null
            ? { cacheControlMaxAge: putOpts.cacheControlMaxAge }
            : {}),
        }),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec tsx --test system/lib/publish/blob.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add system/lib/publish/types.ts system/lib/publish/blob.ts system/lib/publish/blob.test.ts
git commit -m "feat(publish): blob putBlob honors access:public|private"
```

---

### Task 3: Manifest carries fields + splits public/private (`manifest.ts`)

**Files:**
- Modify: `system/lib/publish/types.ts` (`LogRow` fields)
- Modify: `system/lib/publish/manifest.ts`
- Test: `system/lib/publish/manifest.test.ts`

**Interfaces:**
- Consumes: `LogRow` (now with `category`, `visibility`, `description`); `UNCATEGORIZED`.
- Produces: `ManifestEntry` += `category: string; visibility: 'public'|'private'; description: string | null`; `buildManifest()` returns all live entries with those fields (defaulting legacy rows); `writeManifest()` writes `index.json` (public entries, `access:'public'`) and `index.private.json` (private entries, `access:'private'`).

- [ ] **Step 1: Add fields to `LogRow`**

In `system/lib/publish/types.ts`, extend `LogRow`:

```ts
export interface LogRow {
  ts: string;
  action: PublishAction;
  slug: string;
  url: string;
  user_id: string;
  source: string | null;
  blob_key: string;
  title: string | null;
  assets: string[];
  warnings: string[];
  category?: string; // optional: legacy rows predate this
  visibility?: 'public' | 'private';
  description?: string | null;
}
```

- [ ] **Step 2: Write the failing test**

Add to `system/lib/publish/manifest.test.ts`:

```ts
test('buildManifest carries category/visibility/description from latest row', () => {
  const rows = [
    mkRow({ slug: 'a', ts: '2026-01-01T00:00:00Z', action: 'append', category: 'Essays', visibility: 'public', description: 'd1' }),
    mkRow({ slug: 'a', ts: '2026-02-01T00:00:00Z', action: 'overwrite', category: 'Field Guides', visibility: 'private', description: 'd2' }),
  ];
  const m = buildManifest(rows, { publicUrl: 'https://x', userId: 'u' });
  assert.equal(m[0].category, 'Field Guides');
  assert.equal(m[0].visibility, 'private');
  assert.equal(m[0].description, 'd2');
});

test('buildManifest defaults legacy rows (no category/visibility) safely', () => {
  const rows = [mkRow({ slug: 'b', ts: '2026-01-01T00:00:00Z', action: 'append' })];
  const m = buildManifest(rows, { publicUrl: 'https://x', userId: 'u' });
  assert.equal(m[0].category, 'Uncategorized');
  assert.equal(m[0].visibility, 'public');
  assert.equal(m[0].description, null);
});

test('writeManifest writes public array + private array to the right keys', async () => {
  const puts: Array<{ key: string; body: string; access?: string }> = [];
  const blob = {
    headBlob: async () => ({ exists: false }),
    putBlob: async (key: string, body: string, opts?: { access?: string }) => {
      puts.push({ key, body, access: opts?.access });
      return { url: 'u' };
    },
    delBlob: async () => {},
  };
  const rows = [
    mkRow({ slug: 'pub', ts: '2026-01-01T00:00:00Z', action: 'append', category: 'Essays', visibility: 'public' }),
    mkRow({ slug: 'priv', ts: '2026-01-02T00:00:00Z', action: 'append', category: 'Essays', visibility: 'private' }),
  ];
  await writeManifest(blob, { publicUrl: 'https://x', userId: 'u' }, rows);
  const pub = puts.find((p) => p.key === 'users/u/index.json');
  const prv = puts.find((p) => p.key === 'users/u/index.private.json');
  assert.ok(pub && prv);
  assert.equal(prv.access, 'private');
  assert.deepEqual(JSON.parse(pub.body).map((e: { slug: string }) => e.slug), ['pub']);
  assert.deepEqual(JSON.parse(prv.body).map((e: { slug: string }) => e.slug), ['priv']);
});
```

Add a `mkRow` helper at the top of the test file if absent:

```ts
function mkRow(p: Partial<LogRow> & { slug: string; ts: string; action: LogRow['action'] }): LogRow {
  return {
    url: '', user_id: 'u', source: null, blob_key: '', title: p.slug, assets: [], warnings: [],
    ...p,
  } as LogRow;
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec tsx --test system/lib/publish/manifest.test.ts`
Expected: FAIL — `ManifestEntry` lacks fields / `writeManifest` writes one blob.

- [ ] **Step 4: Implement in `manifest.ts`**

Extend `ManifestEntry`:

```ts
export interface ManifestEntry {
  slug: string;
  title: string | null;
  url: string;
  published_at: string;
  updated_at: string;
  category: string;
  visibility: 'public' | 'private';
  description: string | null;
}
```

In `buildManifest`, capture the new fields in the per-slug fold and emit them with defaults. Replace the `bySlug` value shape and the push:

```ts
  const bySlug = new Map<
    string,
    {
      firstTs: string; lastTs: string; lastAction: string;
      title: string | null; category: string; visibility: 'public' | 'private'; description: string | null;
    }
  >();
  for (const e of entries) {
    const cat = e.category ?? UNCATEGORIZED;
    const vis = e.visibility ?? 'public';
    const desc = e.description ?? null;
    const cur = bySlug.get(e.slug);
    if (!cur) {
      bySlug.set(e.slug, {
        firstTs: e.ts, lastTs: e.ts, lastAction: e.action,
        title: e.title, category: cat, visibility: vis, description: desc,
      });
      continue;
    }
    if (e.ts < cur.firstTs) cur.firstTs = e.ts;
    if (e.ts >= cur.lastTs) {
      cur.lastTs = e.ts; cur.lastAction = e.action;
      cur.title = e.title; cur.category = cat; cur.visibility = vis; cur.description = desc;
    }
  }
```

And the push inside the output loop:

```ts
    out.push({
      slug,
      title: v.title,
      url: `${env.publicUrl}/@${env.userId}/${slug}`,
      published_at: v.firstTs,
      updated_at: v.lastTs,
      category: v.category,
      visibility: v.visibility,
      description: v.description,
    });
```

Add the import at the top of `manifest.ts`:

```ts
import { HTML_CACHE_MAX_AGE, UNCATEGORIZED } from './config.ts';
```

Replace `writeManifest` to split + write two blobs:

```ts
export async function writeManifest(
  blob: BlobClient,
  env: { publicUrl: string; userId: string },
  entries: LogRow[],
): Promise<void> {
  const all = buildManifest(entries, env);
  const publicEntries = all.filter((e) => e.visibility !== 'private');
  const privateEntries = all.filter((e) => e.visibility === 'private');
  await blob.putBlob(`users/${env.userId}/index.json`, JSON.stringify(publicEntries), {
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: true,
    access: 'public',
  });
  await blob.putBlob(`users/${env.userId}/index.private.json`, JSON.stringify(privateEntries), {
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: true,
    access: 'private',
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec tsx --test system/lib/publish/manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add system/lib/publish/types.ts system/lib/publish/manifest.ts system/lib/publish/manifest.test.ts
git commit -m "feat(publish): manifest carries category/visibility/description; split public+private"
```

---

### Task 4: Thread classification through `publish()` + visibility-flip cleanup (`orchestrate.ts`)

**Files:**
- Modify: `system/lib/publish/orchestrate.ts`
- Test: `system/lib/publish/orchestrate.test.ts` (create if absent, or add cases)

**Interfaces:**
- Consumes: `classify` (Task 1); `writeManifest` (Task 3); `BlobPutOptions.access` (Task 2).
- Produces: page HTML stored at the visibility-correct prefix; `LogRow` carries `category`/`visibility`/`description`; unknown category / invalid visibility → `PublishError(EXIT_POLICY)`.

- [ ] **Step 1: Write the failing test**

Add to `system/lib/publish/orchestrate.test.ts` (reuse the file's existing in-memory blob mock; if none, build a `Map`-backed `BlobClient`). Two cases:

```ts
test('publish rejects an unknown category', async () => {
  // source markdown with `category: Nope` frontmatter
  await assert.rejects(
    () => publish(makeOpts({ frontmatter: 'category: Nope\n' })),
    /unknown category/i,
  );
});

test('private page stored under the private prefix with access:private', async () => {
  const { putCalls } = makeRecordingBlob();
  await publish(makeOpts({ frontmatter: 'category: Field Guides\nvisibility: private\n', blob: /* recording */ undefined }));
  const pagePut = putCalls.find((c) => c.key.includes('/private/') && c.key.endsWith('/index.html'));
  assert.ok(pagePut, 'page stored under users/<u>/private/<slug>/index.html');
  assert.equal(pagePut.access, 'private');
});
```

(Adapt `makeOpts`/`makeRecordingBlob` to the existing test helpers in the repo; the assertions — reject on unknown category, and private prefix + access — are the contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test system/lib/publish/orchestrate.test.ts`
Expected: FAIL — category not validated; page always under `/pages/` with public access.

- [ ] **Step 3: Implement classification + access**

In `orchestrate.ts`, add the import:

```ts
import { classify } from './categories.ts';
```

After `const { frontmatter, body: bodyRaw } = extractFrontmatter(raw);` and the untrusted check, classify:

```ts
  const classification = classify(frontmatter.category, frontmatter.visibility);
  if (!classification.ok) {
    throw new PublishError(EXIT_POLICY, `Refused: ${classification.error}`);
  }
  const { category, visibility } = classification;
  warnings.push(...classification.warnings);
```

Change `htmlKeyFor` to be visibility-aware:

```ts
  const pagePrefix = visibility === 'private' ? 'private' : 'pages';
  const htmlKeyFor = (s: string): string =>
    `users/${opts.env.userId}/${pagePrefix}/${s}/index.html`;
```

When PUTting the page blob, pass the access:

```ts
  await opts.blobClient.putBlob(htmlKey, fullHtml, {
    contentType: 'text/html; charset=utf-8',
    cacheControlMaxAge: HTML_CACHE_MAX_AGE,
    allowOverwrite: action === 'overwrite',
    access: visibility === 'private' ? 'private' : 'public',
  });
```

Add the three fields to the `LogRow` literal:

```ts
  const logRow: LogRow = {
    ts: nowIsoMs(),
    action,
    slug,
    url: resultBase.url,
    user_id: opts.env.userId,
    source: absSource,
    blob_key: htmlKey,
    title,
    assets: assetKeys,
    warnings,
    category,
    visibility,
    description,
  };
```

- [ ] **Step 4: Add visibility-flip cleanup**

Still in `publish()`, after the page PUT and BEFORE `writeManifest`, delete a stale opposite-prefix blob if this slug was previously published with the other visibility. Read the existing log (already read for the manifest rebuild) and check the latest prior non-delete row:

```ts
  // Visibility flip: if this slug existed at the opposite-visibility prefix,
  // remove that stale blob so a now-private page can't linger at a public URL
  // (and vice versa).
  try {
    const { entries: priorEntries } = await readLog(opts.logPath);
    const prior = [...priorEntries]
      .reverse()
      .find((e) => e.slug === slug && e.action !== 'delete' && e.blob_key !== htmlKey);
    if (prior?.blob_key && (prior.visibility ?? 'public') !== visibility) {
      await opts.blobClient.delBlob(prior.blob_key).catch(() => null);
    }
  } catch {
    // best-effort cleanup
  }
```

(Note: the existing code already calls `readLog` right after for `writeManifest`; you may reuse a single read. Keep `appendLogEntry(logRow)` BEFORE this so the new row is present, or compute against the pre-append log as shown — either is correct since we match on `blob_key !== htmlKey`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec tsx --test system/lib/publish/orchestrate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole publish suite**

Run: `pnpm exec tsx --test system/lib/publish/*.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add system/lib/publish/orchestrate.ts system/lib/publish/orchestrate.test.ts
git commit -m "feat(publish): validate category/visibility, store private pages under private prefix, flip-cleanup"
```

---

### Task 5: One-time backfill script

**Files:**
- Create: `system/scripts/backfill-publish-categories.ts`
- Test: `system/scripts/backfill-publish-categories.test.ts`

**Interfaces:**
- Produces: pure `categoryForSlug(slug: string): string` (a CATEGORIES member); a `main()` that snapshots → patches → atomic-renames the log → rebuilds both manifests.

- [ ] **Step 1: Write the failing test for the mapping**

Create `system/scripts/backfill-publish-categories.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryForSlug } from './backfill-publish-categories.ts';

test('rule-based slugs', () => {
  assert.equal(categoryForSlug('lens-nikon-z-50mm-f1-8-s'), 'Lens Analysis');
  assert.equal(categoryForSlug('critique-2026-06-24'), 'Critiques');
  assert.equal(categoryForSlug('color-grade-dockmaster-wall'), 'Color Grading');
  assert.equal(categoryForSlug('trading-prd-analysis'), 'Projects');
  assert.equal(categoryForSlug('tc-1-4x-fullres-3'), 'Gear & Comparisons');
  assert.equal(categoryForSlug('nikon-z50ii-100-400-vs-180-600-vs-500pf'), 'Gear & Comparisons');
});

test('override-mapped slugs', () => {
  assert.equal(categoryForSlug('jamaica-bay-sunrise-birding'), 'Field Guides');
  assert.equal(categoryForSlug('ugreen-nas-setup-guide'), 'Tools & Setup');
  assert.equal(categoryForSlug('photographer-profile'), 'Essays');
});

test('unknown slug falls back to Uncategorized', () => {
  assert.equal(categoryForSlug('something-totally-new-2099'), 'Uncategorized');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test system/scripts/backfill-publish-categories.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the script**

Create `system/scripts/backfill-publish-categories.ts`. The `OVERRIDES` map below is seeded from the current 112 live slugs; extend it as needed. `categoryForSlug` checks overrides first, then prefix rules, then `Uncategorized`.

```ts
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBlobClient } from '../lib/publish/blob.ts';
import { UNCATEGORIZED } from '../lib/publish/config.ts';
import { readLog } from '../lib/publish/log.ts';
import { writeManifest } from '../lib/publish/manifest.ts';
import type { LogRow } from '../lib/publish/types.ts';
import { resolveUserDataDir } from '../lib/paths.ts';
import { loadEnvFile } from '../lib/secrets/load-env.ts';

/** Exact slug → category overrides (anything the prefix rules don't nail). */
const OVERRIDES: Record<string, string> = {
  'jamaica-bay-sunrise-birding': 'Field Guides',
  'jamaica-bay-sunday-birding': 'Field Guides',
  'constitution-marsh-photography': 'Field Guides',
  'fog-photography-night-predawn-dawn': 'Field Guides',
  'astoria-fog-nocturne': 'Field Guides',
  'west-village-photo-walk': 'Field Guides',
  'nyc-organic-graffiti-photo-guide': 'Field Guides',
  'randalls-island-birds-this-morning': 'Field Guides',
  'still-up': 'Field Guides',
  'golden-hour-warm-preset-guide': 'Color Grading',
  'ugreen-nas-setup-guide': 'Tools & Setup',
  'jake-local-dev': 'Tools & Setup',
  'jake-cheat-sheet': 'Tools & Setup',
  'zf-night-flash-cheatsheet': 'Tools & Setup',
  'nikon-z8-setup': 'Tools & Setup',
  'nikon-user-modes-and-banks': 'Tools & Setup',
  'photographer-profile': 'Essays',
  'photography-practice': 'Essays',
  'kevin-as-photographer': 'Essays',
  'the-buff': 'Essays',
  'getting-to-webb': 'Essays',
  'ten-color-photos': 'Essays',
  'favorite-photos': 'Essays',
  'prime-vs-zoom-street': 'Gear & Comparisons',
  'nikon-sensor-iq-zf-zfc-z50ii-z8': 'Gear & Comparisons',
  'nokton-classic-35-f8-street': 'Essays',
  'fashion-week-queens-shoot-plan': 'Field Guides',
  // prompt / meta artifacts — see STARTER_PRIVATE below
  'critique-prompt': 'Tools & Setup',
  'photo-critique-prompt': 'Tools & Setup',
  'color-grade-skill': 'Tools & Setup',
  'color-grade-assistant': 'Tools & Setup',
};

/**
 * Slugs to flip to visibility:private during backfill. EMPTY by design
 * (decision 2: all stay public). Uncomment entries to hide them immediately.
 */
const STARTER_PRIVATE = new Set<string>([
  // 'critique-prompt',
  // 'photo-critique-prompt',
  // 'kevin-as-photographer',
]);

export function categoryForSlug(slug: string): string {
  if (OVERRIDES[slug]) return OVERRIDES[slug];
  if (slug.startsWith('lens-')) return 'Lens Analysis';
  if (slug.startsWith('critique-')) return 'Critiques';
  if (slug.startsWith('color-grade-')) return 'Color Grading';
  if (slug.startsWith('trading-') || slug.includes('trading')) return 'Projects';
  if (slug.startsWith('tc-') || slug.includes('teleconverter') || slug.includes('-vs-')) {
    return 'Gear & Comparisons';
  }
  if (slug.includes('600-pf') || slug.includes('180-600') || slug.includes('100-400')) {
    return 'Gear & Comparisons';
  }
  if (slug.includes('lens-comparison') || slug.includes('three-35') || slug === '35mm-lens-comparison') {
    return 'Lens Analysis';
  }
  return UNCATEGORIZED;
}

function patchRow(row: LogRow): LogRow {
  return {
    ...row,
    category: row.category ?? categoryForSlug(row.slug),
    visibility: row.visibility ?? (STARTER_PRIVATE.has(row.slug) ? 'private' : 'public'),
    description: row.description ?? null,
  };
}

async function main(): Promise<void> {
  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const userId = process.env.PUBLISH_USER_ID;
  const publicUrl = process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io';
  if (!token || !userId) throw new Error('BLOB_READ_WRITE_TOKEN and PUBLISH_USER_ID required');

  const logPath = join(userData, 'observability', 'publish', 'index.jsonl');
  const { entries } = await readLog(logPath);

  // 1. snapshot
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(`${logPath}.bak-${stamp}`, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 2. patch in memory
  const patched = entries.map(patchRow);

  // 3. atomic rewrite (temp + rename)
  const tmp = `${logPath}.tmp-${stamp}`;
  await writeFile(tmp, patched.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await rename(tmp, logPath);

  // 4. rebuild both manifests
  const blob = createBlobClient({ token });
  await writeManifest(blob, { publicUrl, userId }, patched);

  process.stdout.write(`backfilled ${patched.length} rows; manifests rebuilt.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test system/scripts/backfill-publish-categories.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (do not run the script yet)**

```bash
git add system/scripts/backfill-publish-categories.ts system/scripts/backfill-publish-categories.test.ts
git commit -m "feat(publish): one-time category/visibility log backfill script"
```

---

### Task 6: Document the frontmatter fields

**Files:**
- Create: `system/lib/publish/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the doc**

Create `system/lib/publish/README.md`:

```markdown
# Publish frontmatter

Markdown published via `robin publish <file>` supports these frontmatter fields:

| Field | Values | Default | Notes |
|---|---|---|---|
| `title` | string | first H1 / filename | page + OG title |
| `description` | string | none | meta description + index one-liner |
| `category` | one of the taxonomy below | `Uncategorized` (+ warning) | unknown value → publish refused |
| `visibility` | `public` \| `private` | `public` | `private` → stored in a private blob, indexed only for the admin |

**Taxonomy:** Lens Analysis · Gear & Comparisons · Field Guides · Color Grading · Critiques · Essays · Tools & Setup · Projects.

Robin should set `category:` on every page it publishes (and `visibility: private` for anything not meant for the public index). Forgetting `category` is non-fatal — the page lands in `Uncategorized` with a warning.
```

- [ ] **Step 2: Commit**

```bash
git add system/lib/publish/README.md
git commit -m "docs(publish): document category/visibility frontmatter"
```

---

### Phase 1 deploy + backfill (manual, after Tasks 1–6 reviewed)

- [ ] `pnpm build && pnpm test` green.
- [ ] Restart daemon: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon` (loads new pipeline code).
- [ ] Pause auto-publishing or pick a quiet window, then run the backfill once:
      `pnpm exec tsx system/scripts/backfill-publish-categories.ts`
- [ ] Verify: `curl -s "$BLOB_PUBLIC_BASE_URL/users/<u>/index.json" | jq '.[0]'` shows `category`/`visibility`/`description`; `index.private.json` exists (private — fetch with token).
- [ ] The live old `/@<user>/` index still renders (manifest stayed an array).

---

# Phase 2 — askrobin.io (serving)

> Work in `~/workspace/robin/askrobin.io`. Create branch `feat/published-index-categories-private`. Tests use **Vitest** (`pnpm test` / `pnpm exec vitest run <file>`).

## File structure (Phase 2)

- `apps/web/lib/publish-serve.ts` *(modify)* — `ManifestEntry`, `CATEGORY_ORDER`, `UNCATEGORIZED`, `groupByCategory()`, `fetchManifest()`.
- `apps/web/lib/publish-serve.test.ts` *(modify)* — `groupByCategory` tests.
- `apps/web/app/u/[user]/route.ts` *(rewrite)* — categorized index, two views, `no-store`.
- `apps/web/app/u/[user]/route.test.ts` *(modify)*.
- `apps/web/app/u/[user]/[slug]/route.ts` *(modify)* — private gating + cache headers.
- `apps/web/app/u/[user]/[slug]/route.test.ts` *(modify)*.
- `apps/web/public/_pub/index.js` *(create)* — client search + sort.
- `apps/web/public/_pub/index.js.test.ts` *(create)* — jsdom tests of the pure core.
- `apps/web/public/_pub/index.css` *(create)* — rail/list styles; linked from the index route.

---

### Task 7: Serving helpers — `CATEGORY_ORDER` + `groupByCategory` + `fetchManifest`

**Files:**
- Modify: `apps/web/lib/publish-serve.ts`
- Test: `apps/web/lib/publish-serve.test.ts`

**Interfaces:**
- Produces:
  - `interface ManifestEntry { slug; title: string|null; url; published_at; updated_at; category: string; visibility: 'public'|'private'; description: string|null }`
  - `const CATEGORY_ORDER: string[]` (the 8, mirrored from publish config — `// keep in sync`) and `const UNCATEGORIZED = 'Uncategorized'`.
  - `function groupByCategory(entries: ManifestEntry[]): { category: string; entries: ManifestEntry[] }[]` — groups, orders categories by `CATEGORY_ORDER` then `Uncategorized`, with any unknown category appended alphabetically; entries within a group keep manifest (newest-first) order.
  - `async function fetchManifest(url: string, init?: RequestInit): Promise<ManifestEntry[]>` — fetch + JSON-parse, returns `[]` on 404 or parse error.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/publish-serve.test.ts`:

```ts
import { CATEGORY_ORDER, groupByCategory, type ManifestEntry } from './publish-serve';

function e(slug: string, category: string): ManifestEntry {
  return { slug, title: slug, url: '/x', published_at: '', updated_at: '', category, visibility: 'public', description: null };
}

describe('groupByCategory', () => {
  it('orders by CATEGORY_ORDER, Uncategorized last, unknown appended', () => {
    const groups = groupByCategory([
      e('a', 'Essays'),
      e('b', 'Lens Analysis'),
      e('c', 'Uncategorized'),
      e('d', 'Mystery'),
    ]);
    const order = groups.map((g) => g.category);
    expect(order.indexOf('Lens Analysis')).toBeLessThan(order.indexOf('Essays'));
    expect(order[order.length - 1]).toBe('Uncategorized');
    expect(order).toContain('Mystery');
  });
  it('CATEGORY_ORDER has the 8 categories', () => {
    expect(CATEGORY_ORDER).toHaveLength(8);
    expect(CATEGORY_ORDER[0]).toBe('Lens Analysis');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web/lib/publish-serve.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `publish-serve.ts`**

Append:

```ts
// Mirror of system/lib/publish/config.ts CATEGORIES — keep in sync.
export const CATEGORY_ORDER = [
  'Lens Analysis', 'Gear & Comparisons', 'Field Guides', 'Color Grading',
  'Critiques', 'Essays', 'Tools & Setup', 'Projects',
];
export const UNCATEGORIZED = 'Uncategorized';

export interface ManifestEntry {
  slug: string;
  title: string | null;
  url: string;
  published_at: string;
  updated_at: string;
  category: string;
  visibility: 'public' | 'private';
  description: string | null;
}

export function groupByCategory(
  entries: ManifestEntry[],
): { category: string; entries: ManifestEntry[] }[] {
  const byCat = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    const cat = e.category || UNCATEGORIZED;
    (byCat.get(cat) ?? byCat.set(cat, []).get(cat))!.push(e);
  }
  const rank = (c: string): number => {
    const i = CATEGORY_ORDER.indexOf(c);
    if (i >= 0) return i;
    if (c === UNCATEGORIZED) return CATEGORY_ORDER.length + 1000;
    return CATEGORY_ORDER.length + 1; // unknown, before Uncategorized, sorted by name
  };
  return [...byCat.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, es]) => ({ category, entries: es }));
}

export async function fetchManifest(url: string, init?: RequestInit): Promise<ManifestEntry[]> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web/lib/publish-serve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/publish-serve.ts apps/web/lib/publish-serve.test.ts
git commit -m "feat(serve): CATEGORY_ORDER + groupByCategory + fetchManifest helpers"
```

---

### Task 8: Categorized index route (two views, no-store)

**Files:**
- Rewrite: `apps/web/app/u/[user]/route.ts`
- Test: `apps/web/app/u/[user]/route.test.ts`

**Interfaces:**
- Consumes: `decodeAndValidateUser`, `escapeHtml`, `SECURITY_HEADERS`, `groupByCategory`, `fetchManifest`, `ManifestEntry` (Task 7); `auth` from `../../../auth`; `isAdmin` from `../../../lib/admin`.
- Produces: server-rendered HTML with rail + grouped sections; links `/_pub/index.css` + `/_pub/index.js`; response `cache-control: private, no-store`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/app/u/[user]/route.test.ts`, mock `auth`, `isAdmin`, and global `fetch`. Assert:

```ts
// anon: only public entries rendered, no 🔒 filter, no-store
it('anon sees only public pages and no-store', async () => {
  mockAuth(null);
  mockFetchManifest({ public: [pub('a','Essays')], private: [priv('s','Essays')] });
  const res = await GET(req(), { params: Promise.resolve({ user: 'iser' }) });
  const html = await res.text();
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(html).toContain('>a<'); // public title
  expect(html).not.toContain('>s<'); // private title absent
  expect(html).not.toContain('Private'); // no 🔒 filter for anon
});

it('admin sees private pages + 🔒 filter', async () => {
  mockAuth({ user: { email: 'kevin@x' } });
  mockIsAdmin(true);
  mockFetchManifest({ public: [pub('a','Essays')], private: [priv('s','Field Guides')] });
  const res = await GET(req(), { params: Promise.resolve({ user: 'iser' }) });
  const html = await res.text();
  expect(html).toContain('>s<');
  expect(html).toContain('Private');
});
```

(Provide `pub`/`priv` builders returning `ManifestEntry`, and a `mockFetchManifest` that routes `index.json` vs `index.private.json` to the two arrays.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web/app/u/[user]/route.test.ts`
Expected: FAIL — route still renders a flat `<ul>`, no auth.

- [ ] **Step 3: Rewrite the route**

Replace `apps/web/app/u/[user]/route.ts` body with:

```ts
import { auth } from '../../../auth';
import { isAdmin } from '../../../lib/admin';
import {
  decodeAndValidateUser, escapeHtml, fetchManifest, groupByCategory,
  type ManifestEntry, SECURITY_HEADERS,
} from '../../../lib/publish-serve';

export async function GET(_req: Request, { params }: { params: Promise<{ user: string }> }) {
  const { user: rawUser } = await params;
  const user = decodeAndValidateUser(rawUser);
  if (!user) return notFound();

  const blobBase = process.env.BLOB_PUBLIC_BASE_URL;
  if (!blobBase) return unavailable();

  const publicEntries = await fetchManifest(`${blobBase}/users/${user}/index.json`, { cache: 'no-store' });

  const session = await auth();
  const admin = isAdmin(session?.user?.email);
  let entries: ManifestEntry[] = publicEntries;
  if (admin) {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    // Private manifest is a private blob — fetch via the @vercel/blob download URL with token.
    // (Confirm exact private-read call against current @vercel/blob docs during impl.)
    const priv = token
      ? await fetchManifest(privateManifestUrl(user), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      : [];
    entries = [...publicEntries, ...priv];
  }

  const groups = groupByCategory(entries);
  const html = renderIndex(user, groups, admin);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      ...SECURITY_HEADERS,
    },
  });
}
```

Add `renderIndex(user, groups, admin)` building: header `@user`, a toolbar (`<input id="pub-search">` + a sort `<button>`/`<select id="pub-sort">`), a `<nav class="rail">` of category links + counts (plus a `🔒 Private` rail item when `admin`), and `<section data-category>` blocks each containing `<a>` entries with `data-title`/`data-desc`/`data-date` attributes for the client script. Escape every manifest-derived string with `escapeHtml`. Link `<link rel="stylesheet" href="/_pub/page.css"><link rel="stylesheet" href="/_pub/index.css">` and `<script src="/_pub/index.js" defer></script>`. Keep `notFound()`/`unavailable()` from the current file. Add a `privateManifestUrl(user)` helper returning the private blob's download endpoint.

> Implementation note: the private-manifest fetch is the one spot that needs the real `@vercel/blob` private-read API. If a tokenized GET URL isn't directly available, use `@vercel/blob`'s server SDK to resolve a download URL for `users/<user>/index.private.json`, then fetch it. Verify via the `vercel:vercel-storage` skill before finalizing.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web/app/u/[user]/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/u/[user]/route.ts apps/web/app/u/[user]/route.test.ts
git commit -m "feat(serve): categorized index with rail, two views, no-store"
```

---

### Task 9: Private page gating in `[slug]` route

**Files:**
- Modify: `apps/web/app/u/[user]/[slug]/route.ts`
- Test: `apps/web/app/u/[user]/[slug]/route.test.ts`

**Interfaces:**
- Consumes: `auth`, `isAdmin`, existing `decodeAndValidateUser`/`SLUG_RE`/`SECURITY_HEADERS`.
- Produces: public hit → `public, max-age=60` (unchanged); private hit (admin) → `private, no-store`; every 404 → `no-store`.

- [ ] **Step 1: Write the failing tests**

Add cases to the route test:

```ts
it('anon hitting a private slug gets 404 no-store', async () => {
  mockFetch({ public404: true, privateExists: true });
  mockAuth(null);
  const res = await GET(req(), { params: P({ user: 'iser', slug: 'secret' }) });
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toContain('no-store');
});

it('admin hitting a private slug gets 200 no-store', async () => {
  mockFetch({ public404: true, privateExists: true });
  mockAuth({ user: { email: 'k@x' } }); mockIsAdmin(true);
  const res = await GET(req(), { params: P({ user: 'iser', slug: 'secret' }) });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('no-store');
});

it('public page unchanged: 200 public max-age=60', async () => {
  mockFetch({ public404: false });
  const res = await GET(req(), { params: P({ user: 'iser', slug: 'open' }) });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toContain('max-age=60');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web/app/u/[user]/[slug]/route.test.ts`
Expected: FAIL — no private path; 404s aren't `no-store`.

- [ ] **Step 3: Implement**

In `[slug]/route.ts`, after the public fetch:

```ts
  const upstream = await fetch(`${blobBase}/users/${user}/pages/${slug}/index.html`, { cache: 'no-store' });
  if (upstream.ok) {
    return new Response(upstream.body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60, must-revalidate', ...SECURITY_HEADERS },
    });
  }
  if (upstream.status !== 404) return temporarilyUnavailable();

  // Not public. Only the admin may see a private page; everyone else gets 404.
  const session = await auth();
  if (isAdmin(session?.user?.email)) {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (token) {
      const priv = await fetchPrivatePage(user, slug, token); // resolves private blob via @vercel/blob, returns Response|null
      if (priv) return priv; // body served with cache-control: private, no-store
    }
  }
  return notFound(); // 404 with no-store (see below)
```

Change `notFound()` and `temporarilyUnavailable()` cache headers to `no-store` (a 404 may be a private page hidden from this viewer):

```ts
// notFound(): 'cache-control': 'no-store'
```

Add `fetchPrivatePage(user, slug, token)`: resolve `users/<user>/private/<slug>/index.html` via the `@vercel/blob` private-read API, and on hit return `new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', ...SECURITY_HEADERS } })`, else `null`. (Same private-read confirmation as Task 8.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web/app/u/[user]/[slug]/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/u/[user]/[slug]/route.ts apps/web/app/u/[user]/[slug]/route.test.ts
git commit -m "feat(serve): gate private pages behind admin; no-store on 404s and private hits"
```

---

### Task 10: Client search + sort (`/_pub/index.js`)

**Files:**
- Create: `apps/web/public/_pub/index.js`
- Test: `apps/web/public/_pub/index.js.test.ts`

**Interfaces:**
- Produces a self-initializing script (no module imports — CSP `script-src 'self'`). Pure core attached to `window` for testing: `window.__pubIndex = { filter(query, items), sortItems(items, mode) }` where `items` are `{title, desc, date, el}`.

- [ ] **Step 1: Write the failing test (jsdom)**

Create `apps/web/public/_pub/index.js.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

describe('index.js core', () => {
  beforeAll(() => {
    // jsdom env (vitest config: environment 'jsdom' for this file or globally)
    const code = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    // eslint-disable-next-line no-eval
    window.eval(code);
  });
  it('filter matches title and description, case-insensitive', () => {
    const items = [
      { title: 'Jamaica Bay', desc: 'birding', date: '2026-06-19', el: null },
      { title: 'Lens 50mm', desc: 'sharp', date: '2026-06-16', el: null },
    ];
    const out = (window as any).__pubIndex.filter('bird', items);
    expect(out.map((i: any) => i.title)).toEqual(['Jamaica Bay']);
  });
  it('sortItems az sorts by title; newest by date desc', () => {
    const items = [
      { title: 'B', desc: '', date: '2026-01-01', el: null },
      { title: 'A', desc: '', date: '2026-02-01', el: null },
    ];
    expect((window as any).__pubIndex.sortItems(items, 'az').map((i: any) => i.title)).toEqual(['A', 'B']);
    expect((window as any).__pubIndex.sortItems(items, 'newest').map((i: any) => i.title)).toEqual(['A', 'B']);
  });
});
```

(Add `// @vitest-environment jsdom` at the top of the test file, or set jsdom in vitest config.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/web/public/_pub/index.js.test.ts`
Expected: FAIL — file missing.

- [ ] **Step 3: Implement `index.js`**

```js
(function () {
  function filter(query, items) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => (i.title || '').toLowerCase().includes(q) || (i.desc || '').toLowerCase().includes(q),
    );
  }
  function sortItems(items, mode) {
    const copy = items.slice();
    if (mode === 'az') copy.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else copy.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // newest
    return copy;
  }
  window.__pubIndex = { filter, sortItems };

  function init() {
    const search = document.getElementById('pub-search');
    const sort = document.getElementById('pub-sort');
    const sections = Array.from(document.querySelectorAll('[data-category]'));
    const items = Array.from(document.querySelectorAll('a[data-title]')).map((el) => ({
      title: el.getAttribute('data-title') || '',
      desc: el.getAttribute('data-desc') || '',
      date: el.getAttribute('data-date') || '',
      el: el.closest('li') || el,
    }));
    function apply() {
      const visible = new Set(filter(search ? search.value : '', items).map((i) => i.el));
      for (const i of items) i.el.style.display = visible.has(i.el) ? '' : 'none';
      // hide empty category sections
      for (const sec of sections) {
        const anyVisible = Array.from(sec.querySelectorAll('a[data-title]')).some(
          (a) => (a.closest('li') || a).style.display !== 'none',
        );
        sec.style.display = anyVisible ? '' : 'none';
      }
    }
    function applySort() {
      const mode = sort ? sort.value : 'newest';
      for (const sec of sections) {
        const list = sec.querySelector('ul');
        if (!list) continue;
        const lis = Array.from(list.children);
        lis
          .map((li) => ({ li, t: li.querySelector('a[data-title]') }))
          .sort((a, b) =>
            mode === 'az'
              ? (a.t?.getAttribute('data-title') || '').localeCompare(b.t?.getAttribute('data-title') || '')
              : (b.t?.getAttribute('data-date') || '').localeCompare(a.t?.getAttribute('data-date') || ''),
          )
          .forEach(({ li }) => list.appendChild(li));
      }
    }
    if (search) search.addEventListener('input', apply);
    if (sort) sort.addEventListener('change', applySort);
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/web/public/_pub/index.js.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/_pub/index.js apps/web/public/_pub/index.js.test.ts
git commit -m "feat(serve): client-side search + sort for the index"
```

---

### Task 11: Index styling (`/_pub/index.css`) + visual check

**Files:**
- Create: `apps/web/public/_pub/index.css`

**Interfaces:** none (CSS).

- [ ] **Step 1: Write the CSS**

Create `apps/web/public/_pub/index.css` using the existing `page.css` variables (`--fg`, `--fg-muted`, `--bg`, `--surface`, `--rule`, `--accent`, `--chip` etc. — reuse or define the few new ones, light/dark aware). Style: `.pub-toolbar` (search input + sort), `.pub-layout` (flex: sticky `.pub-rail` + main), `.pub-rail a` with counts, `.cat-h` category headings with a thin rule, `.index li` rows (title link + muted description + tabular date), and a `.lock` marker. Mirror the Direction-B mockup (`/private/tmp/.../scratchpad/.superpowers/brainstorm/76824-1782770384/content/index-directions.html`, direction B block).

- [ ] **Step 2: Visual verification**

Run the askrobin dev server, sign in as the dev admin, and load `/@<user>/`:

```bash
pnpm dev   # then open http://localhost:3000/@iser/
```

Confirm: categories grouped + ordered; rail sticky with counts; search filters; sort toggles; private pages + 🔒 visible only when signed in as admin; light/dark match the article pages. (Use the `/run` or browser tooling to screenshot if helpful.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/public/_pub/index.css
git commit -m "feat(serve): index page styling (Direction B library layout)"
```

---

### Phase 2 deploy

- [ ] Add **`BLOB_READ_WRITE_TOKEN`** (read access to the blob store) and confirm **`ADMIN_EMAILS`** are set in the askrobin Vercel project envs (preview + prod).
- [ ] `pnpm build && pnpm test` green; deploy preview; smoke-test anon vs admin; promote to prod.

---

## Self-review

**Spec coverage** (spec §5.1–§5.4, §6–§8):
- §5.1 data model → Tasks 1 (constants), 3 (LogRow/ManifestEntry), 7 (serve ManifestEntry/CATEGORY_ORDER). ✓
- §5.2 privacy (two manifests, private prefix, gated route, cache headers, env) → Tasks 3, 4, 8, 9 + both deploy checklists. ✓
- §5.3 index (rail, search, sort, two views, progressive enhancement) → Tasks 7, 8, 10, 11. ✓ (progressive enhancement: rail/sections render server-side; only live search/sort need JS.)
- §5.4 backfill (rule+override, log patch, atomic, snapshot, concurrency) → Task 5 + Phase-1 deploy step. ✓
- §5.5 validation/defaults → Tasks 1, 4. ✓
- §6 security → Tasks 4 (no leak), 8/9 (no-store), preserved guards. ✓
- §7 testing → each task is TDD. ✓
- §8 rollout (two deploys, manifest stays array, tolerant) → deploy checklists + Task 3 (array) / Task 7+8 (tolerant defaults). ✓

**Refinements vs spec (documented):** (a) private pages use a distinct `users/<u>/private/<slug>/` prefix rather than reusing the public key with flipped access — removes overwrite-access ambiguity; (b) "auto-publishers emit category" is realized as frontmatter + `README.md` guidance (Task 6), since publishing is agent-driven via the CLI, not a code job.

**Placeholder scan:** the one deliberate unknown — the exact `@vercel/blob` private-read call — is isolated to a single helper in Tasks 8 & 9 with a flagged confirmation step, not a code gap. No TBDs elsewhere.

**Type consistency:** `ManifestEntry` fields (`category`/`visibility`/`description`) identical across publish (`manifest.ts`) and serve (`publish-serve.ts`); `classify` result shape consumed unchanged in Task 4; `BlobPutOptions.access` defined in Task 2 and used in Tasks 3–4.
