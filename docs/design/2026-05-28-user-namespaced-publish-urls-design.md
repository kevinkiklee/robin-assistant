# User-Namespaced Publish URLs — Design

**Date:** 2026-05-28
**Status:** Approved design, pending implementation plan
**Repos touched:** `robin-assistant-v3` (publish pipeline), `askrobin.io` (web routing)

## Goal

Move published pages from the flat `askrobin.io/p/<slug>` scheme to a
user-namespaced scheme `askrobin.io/@<user>/<slug>`, and add a per-user index
at `askrobin.io/@<user>/` that lists everything that user has published.

Built as a multi-*user* foundation (URLs and serving are keyed by user read
from the path), though there remains a single *publisher* (Robin on Kevin's
Mac) for now.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Single rename vs multi-user | **Multi-user** — user is read from the URL path |
| URL shape | **`@`-prefixed**: `/@iser/<slug>`, index at `/@iser/` |
| Index data source | **Manifest-driven** — `users/<user>/index.json` on blob |
| Identity | **Rename userId `kevin` → `iser`**; handle == userId (no mapping layer) |
| Old `/p/<slug>` links | **Dropped** (404 after cutover) |

## Section 1 — Routing & URLs (askrobin.io)

**Verified (Next.js docs):** the `@folder` convention defines parallel-route
*slots* that are **stripped from the URL** (`/@analytics/views` serves as
`/views`). There is no documented behavior for a literal `@` URL segment being
captured by a `[param]`. Therefore we do **not** create any `@`-named folder
and do **not** rely on `[user]` capturing `@iser`.

**Mechanism — config-level rewrite:**
- Public URLs: `askrobin.io/@iser/<slug>` (page) and `askrobin.io/@iser/` (index).
- `next.config` rewrites map the sigil URL to a clean internal route, stripping `@`:
  - `/@:user/:slug` → `/u/:user/:slug`
  - `/@:user` → `/u/:user`
- Internal routes (never user-facing): `app/u/[user]/[slug]/route.ts` (page),
  `app/u/[user]/route.ts` (index). No sigil in the folder tree → no
  parallel-route collision.
- These routes are **public, no auth** — standalone HTML like today's `/p/`
  handler, outside the `(app)` auth group.

**Param hygiene (this is a security boundary, not cosmetics):** `user` is now
untrusted input interpolated into a blob fetch URL
(`${blobBase}/users/<user>/pages/<slug>/index.html`), so it is the SSRF /
path-traversal control. Order is **decode → validate → fail-closed → only then
fetch**:
- URL-decode first (handle `%40` for `@`, and reject any `%2F`/`%2E`/`..`/`/`
  that survive decoding).
- `user`: lowercased, validated `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`
  (empty / `@`-only / traversal chars → 404, no fetch).
- `slug`: existing `SLUG_RE`.
A validation miss here would let a crafted path reach arbitrary blob keys —
so the regexes must run before the URL is constructed, and both routes fail
closed.

**Serve response:** the route sets `content-type: text/html` on the Response
explicitly (as `/p/` does today), so the blob's own stored content-type is
irrelevant to serving — migration needn't preserve blob MIME.

**Canonicalization:** redirect `/u/:user/...` → `/@:user/...` so the internal
path can't become a second public URL. Next runs redirects before afterFiles
rewrites, so no loop. One canonical URL per page. The index responds to both
`/@iser` and `/@iser/` (trailing-slash normalized).

**Risk (bounded):** that `next.config` path matching binds the `@`-literal
source (`/@:user`) cleanly. `@` is a literal in path-to-regexp, so it should.
Fallback: the existing middleware operates on the raw URL and can rewrite
unconditionally. Either way the public `@` URL is delivered — no design change.

## Section 2 — Publish pipeline + manifest (robin-assistant-v3)

**URL + identity:** `system/lib/publish/orchestrate.ts` builds
`${publicUrl}/@${userId}/${slug}` (was `${publicUrl}/p/${slug}`, ~3–4 sites).
Blob key unchanged (already `users/${userId}/pages/${slug}/index.html`).
`PUBLISH_USER_ID` env flips `kevin` → `iser` (`user-data/config/secrets/.env`);
the CLI (`system/surfaces/cli/publish.ts`) already threads it through.

**Manifest reducer (new — `groupBySlug` is insufficient):** `groupBySlug`
discards `title` and keeps only `lastTs`, so it cannot produce the manifest. A
new reducer folds the LogRow log (`observability/publish/index.jsonl`, which
carries `title`/`url`/`user_id`) into per-slug entries:
- `title` ← latest LogRow title for the slug
- `published_at` ← **earliest** ts; `updated_at` ← **latest** ts
- drop slugs whose latest action is `delete`
- `url` **recomputed** as `${publicUrl}/@${userId}/${slug}` at build time — not
  read from the historical log — so old `/p/` URLs never leak into the manifest.

Manifest is PUT to `users/<userId>/index.json` on every
publish/overwrite/as-new/**delete**.

**Single-publisher assumption (explicit):** the reducer treats all log entries
as the current instance's user (no per-user filter), valid because Robin is the
sole publisher. **Future boundary:** true multi-publisher would reconcile
against blob `list({prefix})` (authoritative but metadata-poor) rather than the
local log. Not built (YAGNI).

**Write ordering & isolation:** page blob committed → *then* manifest PUT, so the
index never links to a not-yet-written page. Manifest write is best-effort and
after-commit; failure logs a warning and never fails the publish — the next
publish's full rebuild repairs it (rebuild-from-log also makes concurrent
publishes converge). Manifest holds only already-public metadata. `max-age=60`.

**Scaling:** manifest lists all pages (~150 B/entry); fine for hundreds.
Pagination is a later concern.

## Section 3 — Index rendering, migration, testing

**Index rendering (`/@iser/`):** `app/u/[user]/route.ts` fetches
`users/<user>/index.json` and server-renders an HTML list with `/_pub/page.css`
— titles linking to `/@user/<slug>`, newest-first, with dates. **All
manifest-derived strings (titles especially) are HTML-escaped** before
interpolation — the index is web-rendered outside the pipeline's sanitizer, so
escaping is mandatory (XSS prevention; titles are user-controlled frontmatter).
States: manifest 404 → page 404 (unknown user); present-but-empty → "nothing
published yet." Same security headers/CSP as the page route.
- *Rejected alt:* pipeline pre-renders `index.html` — couples layout to a Robin deploy.

**Migration (one-time, throwaway script — run-then-remove, not shipped in the
package):**
1. Enumerate `users/kevin/` via `list({prefix})` — **paginate** with
   `hasMore`/`cursor` (a single call is capped, so loop until `hasMore` is
   false). For each `blob.pathname`, `copy(pathname, pathname.replace('users/kevin/','users/iser/'), {access:'public'})`.
   Copies the **entire subtree** (page HTML + image assets + any other keys);
   `copy()` preserves content-type (verified: `@vercel/blob` `copy()` takes a
   pathname source and echoes `contentType` in its result).
2. Rewrite local `index.jsonl` entries `user_id: kevin → iser`.
3. Build + PUT `users/iser/index.json`.
4. Flip `PUBLISH_USER_ID → iser`; drop the web serve path's use of
   `PUBLISH_DEFAULT_USER_ID` (user now comes from the URL).
5. **Verify** `/@iser/<slug>` + `/@iser/` serve, **then** delete orphaned
   `users/kevin/` blobs as a separate manual step (kevin subtree is the rollback
   copy until then).

**Deploy sequencing (avoids a dead-link window):**
1. Ship web routes first (`/@user/*` serve + index + rewrite + redirect) while
   `/p/` still works.
2. Run the migration.
3. Flip Robin's `PUBLISH_USER_ID` + `/@user/<slug>` URL scheme.
4. Remove the `/p/` route **last**.

**Testing:**
- *Pipeline:* manifest reducer (title, first/last dates, delete-drop, empty,
  URL recompute); update existing `/p/`-asserting tests → `/@iser/`.
- *Web:* rewrite binds `/@:user/:slug`; serve handler (valid/invalid/`%40`-encoded
  user, **path-traversal user (`..`, `%2F`) → 404 with no fetch**, missing-page
  404); index handler (render, **title-escaping/XSS test**, empty state,
  unknown-user 404); `/u/*`→`/@*` redirect; old `/p/<slug>` 404s.
  Match askrobin.io's existing Vitest/Playwright setup.
- *Manual:* curl both URLs post-deploy.

## Docs to update (prevent rot)

The `/p/<slug>` scheme is referenced in prose that will go stale on cutover —
update as part of this work:
- `docs/PUBLISHING.md` (robin-assistant-v3) — URL scheme + index.
- `robin-assistant-v3/CLAUDE.md` — the publish-pipeline paragraph
  ("served at askrobin.io/p/<slug>", "Route handler is at
  askrobin.io/apps/web/app/p/[slug]/route.ts").
- Any askrobin.io README/docs referencing `/p/`.

## Out of scope (YAGNI)

- Authentication / user accounts (content is still a single publisher's).
- Reserved-username blocklist (the `@` sigil removes route-collision risk).
- Index pagination, search, RSS.
- Multi-publisher reconciliation against blob listing.
