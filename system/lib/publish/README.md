# Publish page format

Page metadata and what the publisher does to a page. Commands, URLs, categories,
refusals and secrets: [`docs/PUBLISHING.md`](../../../docs/PUBLISHING.md).

Markdown published via `robin publish --source <file>` supports these frontmatter fields:

| Field | Values | Default | Notes |
|---|---|---|---|
| `title` | string | first H1 / filename | page + OG title |
| `description` | string | none | meta description + dashboard one-liner |
| `category` | one of `CATEGORIES` in `config.ts` | `Uncategorized` (+ warning) | unknown value → publish refused |
| `slug` | string | derived from title / filename | treated like `--slug`: overwrites |
| `trust` | `untrusted` / `untrusted-mixed` | none | refused unless `--force-untrusted` |
| `visibility` | `public` | none | legacy no-op; `private` is refused |

Robin should set `category:` on every page it publishes. Forgetting it is non-fatal:
the page lands in `Uncategorized` with a warning, and does again on every republish.

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
  uploaded (JPEG/PNG/GIF/WebP/AVIF by content sniff, ≤10 MB, no SVG; local
  `srcset`/`<source>` dropped); local attachment hrefs → uploaded
  files (`files.ts`: xmp, cube, dcp, lrtemplate, gpx, csv, zip, pdf, ics; downloads
  keep their filename; never html/svg/js); local `<script src>` and `<link
  rel=stylesheet>` → **inlined** (blob-hosted JS/CSS would be CSP-blocked) — only
  `.js`/`.mjs`/`.css` files, and never through a symlink that leaves the source dir.
- **Warned:** off-list script/style hosts, cross-origin iframes, `<form>`
  posts, `<object>`/`<embed>`, and in-script sandbox traps — storage/cookie
  access (throws), alert/confirm, eval, and OSM/CARTO/Stadia map tiles (refused
  without a Referer; use Esri ArcGIS).
- **Refused:** see the discretion gate in `docs/PUBLISHING.md` (both formats).

Recall: `system/brain/cognition/ingest-docs.ts` indexes `.md` and `.html` (not
`.htm`) under `content/knowledge/` and `content/profile/`, HTML as visible text
(`system/lib/html-text.ts`), so HTML pages stay searchable.
