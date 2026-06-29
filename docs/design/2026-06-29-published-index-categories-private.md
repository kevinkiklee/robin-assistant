# Published Pages: Categorized Index + Private Pages — Design

**Date:** 2026-06-29
**Status:** Approved design, pending spec review → implementation plan
**Author:** Kevin + Robin (brainstorming session)
**Repos touched:** `robin-assistant-v3` (publish pipeline, the bulk) and `askrobin.io` (serving)

---

## 1. Problem

The published-pages index at `askrobin.io/@iser/` renders as a single flat
bulleted list of `title + date`, sorted newest-first. There are now **112+
pages** and growing (lens analyses, critiques, color grades, field guides,
gear comparisons), so the flat list is unusable for finding anything.

Kevin wants three things:

1. **A better index** — grouped by category, searchable, sortable, and good-looking.
2. **Public vs. private pages** — some pages visible to anyone, some visible
   only to Kevin when logged in. "Private" must be *real*, not just unlisted.
3. **Categories** — a fixed taxonomy he controls, one category per page.

## 2. Goals / Non-goals

**Goals**
- Group the index by a fixed 8-category taxonomy, one category per page.
- A sticky category rail (Direction B, "library" layout), client-side search,
  and a newest ↔ A–Z sort.
- Truly private pages: private blob storage + an auth-gated serving route, so a
  leaked URL shows a stranger nothing and private titles never reach public
  storage.
- One index page, two views: anonymous sees public pages; logged-in admin
  (Kevin) additionally sees private pages and a synthetic 🔒 Private filter.
- Backfill all 112 existing pages with categories without re-publishing them.

**Non-goals**
- No multi-user sharing of private pages (audience is "only Kevin" — the
  existing `isAdmin` allowlist). Sharing with named others is explicitly out.
- No per-page passwords / accounts beyond the existing Auth.js Google login.
- No pagination (the DOM-render approach is comfortable into the low thousands;
  past that is a future concern, not this work).
- No change to the published *page* template/styling — this is index + storage
  + serving only.

## 3. Decisions (locked during brainstorming)

| # | Decision |
|---|---|
| Audience of private pages | Only Kevin (existing `isAdmin(email)` allowlist). |
| Privacy strength | Truly private: private blobs + gated route, not "unlisted". |
| Category source | Fixed taxonomy, validated at publish. One category per page. |
| Taxonomy | Lens Analysis · Gear & Comparisons · Field Guides · Color Grading · Critiques · Essays · Tools & Setup · Projects |
| Index layout | Direction B — sticky category rail + grouped list. |
| Index extras | Search box + newest/A–Z sort (both client-side JS). |
| Missing category at publish | **Warn + bucket as "Uncategorized"** (don't break auto-publishers). |
| Unknown category / invalid visibility | **Reject** the publish (`EXIT_POLICY`). |
| Backfill default visibility | All 112 stay **public**; a documented `STARTER_PRIVATE` candidate list ships commented-out for one-line opt-in. |

## 4. Architecture overview

```
Publish (robin-assistant-v3/system/lib/publish)
  frontmatter { category, visibility, description }
    → validate (category ∈ CATEGORIES; visibility ∈ {public,private})
    → page HTML PUT to blob:
         public  → access:'public'  at users/<u>/pages/<slug>/index.html
         private → access:'private' at users/<u>/pages/<slug>/index.html
    → append LogRow { …, category, visibility, description }
    → rebuild manifests from the log:
         index.json          (public blob)  = public entries only
         index.private.json  (private blob) = private entries only

Serve (askrobin.io/apps/web)
  /@<u>/           → u/[user]/route.ts
       fetch index.json (public). If isAdmin(session): also fetch
       index.private.json (token). Render rail + grouped list. no-store.
  /@<u>/<slug>     → u/[user]/[slug]/route.ts
       public blob hit → serve (public,max-age=60).
       404 + isAdmin → private blob fetch (token) → serve (private,no-store).
       else 404 (no-store).
```

## 5. Detailed design

### 5.1 Data model

**Frontmatter (authoring surface).** Two new optional fields, parsed exactly
like `title`/`description` today (`gray-matter`, in `pipeline.ts`):

```yaml
category: Field Guides      # must be one of CATEGORIES
visibility: private         # public (default) | private
```

**Taxonomy constant.** Single source of truth in
`system/lib/publish/config.ts`:

```ts
export const CATEGORIES = [
  'Lens Analysis', 'Gear & Comparisons', 'Field Guides', 'Color Grading',
  'Critiques', 'Essays', 'Tools & Setup', 'Projects',
] as const;
export const UNCATEGORIZED = 'Uncategorized'; // fallback bucket, rendered last
```

**`LogRow`** (`types.ts`) gains `category: string`, `visibility: 'public' |
'private'`, `description: string | null`. `buildManifest` carries each from the
**latest** row per slug, the same fold it already does for `title`.

**Manifest stays a bare JSON array.** Extra fields go *on each entry*, never on
the top level — the live old index route does `(await res.json()) as
ManifestEntry[]` then `.map`, so changing the top-level shape would break it
during the deploy gap. `ManifestEntry` gains `category`, `visibility`,
`description`. Category **order** for the rail is a `CATEGORY_ORDER` constant
mirrored in the askrobin route (with a `// keep in sync with publish config`
note); any category the mirror doesn't recognize is appended after the known
ones, so a lagging mirror never hides pages.

### 5.2 Privacy

**Blob storage.** `blob.ts`'s `putBlob` currently hardcodes `access:'public'`.
It gains an `access` option. Public pages: unchanged. Private pages: PUT with
`access:'private'`. (Confirm the exact `@vercel/blob` private read API —
signed-URL vs. token download — against current Vercel docs during planning;
the `vercel:vercel-storage` skill covers this.)

**Two manifests.** `writeManifest` splits the log fold by `visibility`:
- `users/<u>/index.json` — **public** blob, public entries only.
- `users/<u>/index.private.json` — **private** blob, private entries only.

Private titles/slugs/descriptions therefore never live in any public blob.

**Visibility change handling.** When a re-publish flips a slug's visibility, the
pipeline deletes the stale blob in the *other* access store (public→private
removes the public blob, and vice versa) so a now-private page cannot linger at
a public URL.

**Serving — index route** (`u/[user]/route.ts`):
- Always fetch `index.json`.
- `const session = await auth()`; if `isAdmin(session?.user?.email)`, also fetch
  `index.private.json` via the blob read token and merge. A 404 there (no
  private pages yet) is treated as empty.
- Response is **`cache-control: private, no-store`** — the body varies by
  session and must never be shared-cached.

**Serving — page route** (`u/[user]/[slug]/route.ts`):
- Try the public blob (tokenless, as today). Hit → serve `public, max-age=60`.
- On 404: `await auth()`; if `isAdmin`, fetch the private blob via token.
  Hit → serve **`private, no-store`**. Miss → 404.
- **Every 404 is `no-store`** — a 404 may be a private page hidden from this
  viewer, so it must never be cached publicly (else an anon 404 could mask
  Kevin's own page, or a cached response could cross auth states).

> **Security rationale (the bug caught in review):** both routes are currently
> `public, max-age=60`. Once the index varies by auth and `/@u/<slug>` is
> 404-to-anon / 200-private-to-admin for the *same URL*, public edge-caching
> would leak the private-laden index to strangers and/or mask private pages.
> All auth-dependent responses are `no-store`.

**New env (askrobin web):** the serving route now needs the **blob read token**
(`BLOB_READ_WRITE_TOKEN` or a read-scoped token) and the existing
**`ADMIN_EMAILS`** (already configured for the proxy).

**Alternative considered & rejected:** store private HTML in the app's Postgres
and serve from there. Rejected — it forks storage across two systems; private
blobs keep the publish pipeline single-model.

### 5.3 Index page (Direction B)

Server-rendered HTML from `u/[user]/route.ts`, styling under `/_pub`:

- Header `@<user>` + tagline; a toolbar with a **search input** and a
  **Newest / A–Z** control; a **sticky left category rail** listing each
  category + count; the main column groups entries under category headings,
  each entry showing **title · optional description · date**.
- **Two views, one page:** anon → public categories + public counts;
  admin → also private entries, private counts, and a synthetic 🔒 Private
  filter. Counts are computed from whichever entries the viewer may see.
- **Sort** reorders entries *within* each category (taxonomy order of the
  categories themselves is fixed). Newest is default.
- **Interactivity** lives in a new `/_pub/index.js` (CSP already permits
  `script-src 'self'`): live search filter + sort toggle, operating on the
  already-rendered DOM. **Progressive enhancement:** with no JS, the page is a
  plain grouped list and the rail entries are anchor links to each category
  section; only live-search/sort require the script.
- Rail/list CSS extends the existing `/_pub` stylesheet so the index matches the
  article pages (shared palette, light/dark).
- All manifest-derived strings remain HTML-escaped (the index is rendered
  outside the publish sanitizer; titles are user-controlled).

### 5.4 Backfill of existing 112 pages

The manifest is rebuilt from the **log**, so categories must be written into the
log, not just the manifest.

- One-time script `system/scripts/backfill-publish-categories.ts`:
  1. **Snapshot** the log file (timestamped copy).
  2. Read all rows; assign each a `category` via **deterministic slug rules +
     an explicit `SLUG_CATEGORY_OVERRIDES` map** (generated from the known 112
     titles). Default `visibility: 'public'`; an empty, commented
     `STARTER_PRIVATE` set documents candidates (the `*-prompt` artifacts, raw
     profile dumps) for one-line opt-in.
  3. Write the patched log to a **temp file, then atomic rename**.
  4. Rebuild + write both manifests.
- **Concurrency:** the daemon appends to this log live (nightly auto-publishes).
  Run the backfill in a quiet window (or with publishing briefly paused); the
  snapshot + atomic-rename bound the blast radius if a write races.
- No page HTML changes, no re-publishing — category is index-only metadata.

Rule sketch (covers ~90% deterministically): `lens-*`→Lens Analysis;
`critique-*`→Critiques; `color-grade-*`→Color Grading; `trading-*`→Projects;
`tc-*` and the `*-vs-*`/comparison slugs→Gear & Comparisons. The override map
handles essays, field guides, and tools by exact slug.

### 5.5 Validation & defaults (publish pipeline)

- `category` present but ∉ `CATEGORIES` → **reject** (`EXIT_POLICY`).
- `visibility` present but ∉ {`public`,`private`} → **reject** (`EXIT_POLICY`).
- `category` absent → bucket as `Uncategorized` + push a publish **warning**.
- `visibility` absent → `public`.
- Robin's auto-publishers (critique, color-grade jobs) are updated to set their
  category explicitly so they never fall into Uncategorized.

## 6. Security considerations

- Private page metadata (title/slug/description) never written to a public blob.
- Private blob bodies only fetched server-side with the token, only for
  `isAdmin` sessions, and served `no-store`.
- All auth-dependent route responses (index always; page 404s and private hits)
  are `no-store` — no cross-auth edge caching.
- Existing path-traversal/SSRF guards (`decodeAndValidateUser`, `SLUG_RE`) and
  HTML escaping are preserved unchanged.
- Daily-brief refusal (`REFUSED_SLUG_PATTERN`) is untouched and still applies.

## 7. Testing strategy

**Publish (`robin-assistant-v3`)**
- `buildManifest` splits public vs. private correctly; carries
  category/visibility/description from the latest row.
- Validation: reject unknown category; reject invalid visibility; missing
  category → Uncategorized + warning; missing visibility → public.
- Visibility flip deletes the stale-store blob.
- Backfill mapping is a pure, unit-tested function (slug → category).

**Serve (`askrobin.io`)**
- Index: anon sees only public entries/counts; admin (mocked session) sees
  private entries + 🔒 filter; response is `no-store`.
- Page: private slug → 404 for anon, 200 for admin; private hit is `no-store`;
  every 404 is `no-store`; public hit unchanged.
- `index.private.json` missing → treated as empty (no crash).
- HTML escaping of titles/descriptions preserved.

## 8. Rollout

Two independent deploys, both tolerant in either order:
1. **Publish side** — data model, validation, two-manifest writer, blob `access`
   option; then **run the backfill** (manifest stays an array, so the live old
   route keeps working).
2. **askrobin side** — index redesign, `/_pub/index.js` + CSS, private gating in
   the page route, **new env vars** (blob read token; `ADMIN_EMAILS` present).

Compatibility: old route ignores new per-entry fields; new route buckets
categoryless entries as Uncategorized and treats a missing private manifest as
empty. `pnpm build` + daemon restart on the publish side; Vercel deploy on the
web side.

## 9. File change inventory (for the implementation plan)

**robin-assistant-v3**
- `system/lib/publish/config.ts` — `CATEGORIES`, `UNCATEGORIZED`.
- `system/lib/publish/types.ts` — `LogRow` + `ManifestEntry` new fields;
  `BlobPutOptions.access`.
- `system/lib/publish/pipeline.ts` — parse/validate `category`, `visibility`.
- `system/lib/publish/blob.ts` — honor `access` in `putBlob`.
- `system/lib/publish/manifest.ts` — split the log fold by visibility; write
  both manifests (public-access `index.json` + private-access `index.private.json`).
- `system/lib/publish/orchestrate.ts` — wire fields through; visibility-flip
  cleanup; write both manifests.
- `system/scripts/backfill-publish-categories.ts` — new one-time script + map.
- Auto-publisher jobs (critique, color-grade) — emit `category`.
- Collocated `*.test.ts` updates.

**askrobin.io/apps/web**
- `app/u/[user]/route.ts` — rail + grouped render, two views, `no-store`.
- `app/u/[user]/[slug]/route.ts` — private gating, cache headers.
- `lib/publish-serve.ts` — `CATEGORY_ORDER`, private-manifest fetch helper.
- `public/_pub/index.js` — search + sort (new).
- `public/_pub/*.css` — rail/list styles.
- Env: blob read token wired into the serving runtime.
- Collocated tests.

## 10. Decisions log / open items for spec review

- **Starter private set (decision 2):** defaulting to **all-public**; the
  `STARTER_PRIVATE` list ships commented. Veto/expand at review if you'd rather
  hide the `*-prompt`/profile artifacts immediately.
- **`@vercel/blob` private read API** — confirm exact call during planning.
- **`auth()` inside a plain Route Handler** — Auth.js v5 supports this; verify
  in the askrobin context during implementation.
