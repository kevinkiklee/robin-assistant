---
description: Watches — topics Robin actively follows on user's behalf
type: reference
---

# Watches sub-index

One file per watch, slugged by id (`<id>.md`). Frontmatter drives the watch-topics job. Maintained by the watch-topics agent-runtime job + the `robin watch` CLI.

To add a watch: `robin watch add "<topic>"`. To list: `robin watch list`. The watch-topics job (when enabled) runs hourly, iterates active watches, fetches via WebSearch, dedupes, writes deltas to inbox with `[watch]` tag.
