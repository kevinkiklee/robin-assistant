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
