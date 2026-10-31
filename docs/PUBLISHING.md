# Publishing to the web

`robin publish` uploads a page to Vercel Blob, served from your configured domain (default: `askrobin.io`). A standalone `.html` / `.htm` document is the default format and publishes as itself; a markdown file is sanitized and wrapped in the site template. Field-level detail is in `system/lib/publish/README.md`.

Every page serves at `<domain>/@<user>/<slug>-<hash>`. The `@<user>` segment comes from `PUBLISH_USER_ID`, and `<hash>` is 10 hex chars of an HMAC of `<user>/<slug>` keyed by `PUBLISH_URL_SECRET`, so URLs can't be guessed but stay stable across republishes. Links to `/@<user>/<slug>` in a source doc are rewritten to the hashed form. Pages are served `noindex` but are **not access-controlled**: anyone with the URL can read them. The index at `<domain>/@<user>/` is password-gated on the serving side.

## Commands

```bash
robin publish --source page.html                   # derive slug; suffix on collision
robin publish --source post.md --slug foo           # explicit slug; overwrites if it exists
robin publish --source post.md --mode as-new        # always mint a new suffixed slug
robin publish --source page.html --dry-run          # render + check without uploading
robin publish --mode delete --slug foo              # remove the page + its tracked assets
robin publish --mode recategorize --slug foo --category "Field Guides"
robin published [--all]                             # list published pages
```

Local images and attachments referenced by the page are uploaded with content-hash keys (idempotent on re-upload) and the links rewritten. In an HTML page, local `<script src>` and stylesheet links are inlined (`.js`/`.mjs`/`.css` only; symlinks out of the source directory are refused).

## JavaScript

Scripts in an HTML page run, sandboxed at serve time: the page CSP adds `sandbox allow-scripts` without `allow-same-origin`, so each page runs at an opaque origin with no access to the site's cookies, storage, or API. `localStorage`, `sessionStorage`, `indexedDB`, and `document.cookie` throw; `eval` is blocked. Scripts may load from cdnjs, jsdelivr, and unpkg; stylesheets and fonts also from Google Fonts. The publisher warns about anything the CSP will block or the sandbox will break. The host lists in `system/lib/publish/config.ts` mirror the serving CSP in the askrobin.io repo, and nothing enforces the mirror, so change both together.

## Refusals

Publishing refuses with a non-zero exit when:

- **Discretion gate** (`system/lib/publish/discretion.ts`): the page carries a credential shape anywhere (including scripts), a PII shape in the visible text, or a booking reference (in the text or in page JavaScript). Checked on the source before any upload and again on the rendered page. Override a verified false positive with `--allow-sensitive`.
- **Trust**: frontmatter `trust: untrusted` / `untrusted-mixed` (or `<meta name="robin:trust">`) refuses unless `--force-untrusted` is passed. `<!-- UNTRUSTED-START -->` / `<!-- UNTRUSTED-END -->` blocks are always stripped.
- **Category**: an unknown `category` value. A missing one publishes to `Uncategorized` with a warning.
- **Slug**: any `daily-brief` slug (the brief is never published), or a slug starting with `_`.

## Required secrets

Set these in `user-data/config/secrets/.env`:

| Secret | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token with write access |
| `PUBLISH_USER_ID` | The `@<user>` namespace and blob key prefix (`users/<id>/…`) |
| `BLOB_PUBLIC_BASE_URL` | Public Blob CDN base URL |
| `PUBLISH_URL_SECRET` | HMAC key for the URL hash. Publish refuses without it; rotating it changes every page URL |
| `PUBLISH_PUBLIC_URL` | Canonical URL prefix (optional; default `https://askrobin.io`) |
