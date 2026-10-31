# Publish frontmatter

Markdown published via `robin publish <file>` supports these frontmatter fields:

| Field | Values | Default | Notes |
|---|---|---|---|
| `title` | string | first H1 / filename | page + OG title |
| `description` | string | none | meta description + index one-liner |
| `category` | one of the taxonomy below | `Uncategorized` (+ warning) | unknown value → publish refused |

**Taxonomy:** Lens Analysis · Gear & Comparisons · Field Guides · Color Grading · Critiques · Essays · Tools & Setup · Projects.

Robin should set `category:` on every page it publishes. Forgetting `category` is non-fatal — the page lands in `Uncategorized` with a warning.

## URL model (since 2026-08-19)

Every page serves at `/@<user>/<slug>-<hash>` where `<hash>` is 10 hex chars of
HMAC-SHA256(`<user>/<slug>`) keyed by `PUBLISH_URL_SECRET`
(user-data/config/secrets/.env; publish refuses to run without it). URLs are
unguessable but stable: republishing the same slug keeps the same URL. Markdown
links to `/@<user>/<slug>` (bare or absolute) are rewritten to the hashed form
at publish time, so source docs keep plain slugs. The `/@<user>/` index page now
redirects to the operator's private dashboard (2026-10-31), which lists pages from
the local publish log via its own sync, behind its own sign-in. The serving-side
index code, its password and the `index.json` manifest are slated for removal.

`visibility:` frontmatter was removed with the private-page system (2026-08-19).
`visibility: public` is tolerated as a legacy no-op; `visibility: private` is
refused so a formerly-private doc can never silently publish to a public URL.

## Standalone HTML pages — the default (since 2026-10-26)

New pages are authored as complete `.html` / `.htm` documents — their own
`<head>`, inline `<style>`, layout — and publish as themselves rather than
inside the markdown template (`html-page.ts`). Markdown is the fallback.
Metadata lives in the document:

| Tag | Equivalent frontmatter |
|---|---|
| `<title>` | `title` |
| `<meta name="description" content="…">` | `description` |
| `<meta name="robin:category" content="Field Guides">` | `category` |
| `<meta name="robin:slug" content="…">` | `slug` |
| `<meta name="robin:trust" content="untrusted">` | `trust` (refused unless `--force-untrusted`) |

`robin:*` metas are directives and are removed from the published page.

What the publisher does to an HTML page (`html-page.ts`) — targeted rewrites,
not an allowlist sanitizer; the security boundary is the serving CSP:
- **JavaScript runs** (2026-10-26), sandboxed at serve time: askrobin.io's
  `PAGE_SECURITY_HEADERS` = `sandbox allow-scripts allow-popups
  allow-popups-to-escape-sandbox allow-downloads` (no `allow-same-origin` →
  opaque origin, no askrobin cookies/storage/API), scripts from 'self' + inline +
  `PAGE_SCRIPT_HOSTS` (cdnjs, jsdelivr, unpkg), no eval, `connect-src https:`.
  The direct blob URL serves HTML as an attachment with `default-src 'none'`, so
  script never runs there. Host lists in `config.ts` MIRROR that header — change
  both repos together.
- **Removed:** `<base>`, `<meta http-equiv>` (refresh), `robin:*` directives,
  author robots metas, `<!-- UNTRUSTED-START -->` blocks.
- **Forced:** exactly one `<meta name="robots" content="noindex">`.
- **Rewritten:** internal `/@<user>/<slug>` hrefs → hashed; local `<img src>` →
  uploaded (local `srcset`/`<source>` dropped); local attachment hrefs → uploaded
  files (`files.ts`: xmp, cube, dcp, lrtemplate, gpx, csv, zip, pdf; downloads
  keep their filename; never html/svg/js); local `<script src>` and `<link
  rel=stylesheet>` → **inlined** (blob-hosted JS/CSS would be CSP-blocked) — only
  `.js`/`.mjs`/`.css` files, and never through a symlink that leaves the source dir.
- **Warned:** off-list script/style hosts, cross-origin iframes, `<form>`
  posts, `<object>`/`<embed>`, and in-script sandbox traps — storage/cookie
  access (throws), alert/confirm, eval, and OSM/CARTO/Stadia map tiles (refused
  without a Referer; use Esri ArcGIS).
- **Refused** (`discretion.ts`, both formats): credential shapes anywhere in
  the page (including scripts), PII shapes in visible text, booking references
  (visible text and page JS).
  `--allow-sensitive` overrides a verified false positive.

Recall: `ingest-docs.ts` indexes `.html` under `content/knowledge/` as visible
text (`system/lib/html-text.ts`), so HTML pages stay searchable.
