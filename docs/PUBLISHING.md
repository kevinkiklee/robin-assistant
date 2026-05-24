# Publishing to the web

`robin publish` uploads a markdown file as a sanitized HTML page served from your configured domain (default: `askrobin.io`). Local images referenced in the markdown are uploaded to Vercel Blob with content-hash keys (idempotent on re-upload) and rewritten in the published HTML.

## Commands

```bash
robin publish --source path/to/post.md             # derive slug; suffix on collision
robin publish --source path/to/post.md --slug foo   # explicit slug; overwrites if exists
robin publish --mode delete --slug foo               # remove HTML + tracked assets
robin publish --source path/to/post.md --dry-run     # render + size-check without uploading
robin published                                      # list published pages
```

## Required secrets

Set these in `user-data/config/secrets/.env`:

| Secret | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token with write access |
| `PUBLISH_USER_ID` | Namespace for blob keys (`users/<id>/pages/<slug>/index.html`) |
| `BLOB_PUBLIC_BASE_URL` | Public Blob CDN base URL |
| `PUBLISH_PUBLIC_URL` | Canonical URL prefix (default: `https://askrobin.io`) |

## Trust model

Frontmatter `trust: untrusted` (or `untrusted-mixed`) blocks publication unless `--force-untrusted` is passed. Inline `<!-- UNTRUSTED-START -->` / `<!-- UNTRUSTED-END -->` blocks are stripped regardless of the trust level.
