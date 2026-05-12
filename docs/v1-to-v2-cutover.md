# v1 → v2 cutover runbook

This is the operator-facing playbook for migrating a v1 (markdown-era) Robin
install to v2. The migrator is one-directional, idempotent, and rollback-safe.

Design spec: `docs/superpowers/specs/2026-05-11-v1-to-v2-data-migrator-design.md`.

## Prerequisites

- v2 is installed and `robin migrate` has been run (so migration `0023-v1-imports.surql`
  is applied to the target DB).
- The v2 daemon is **stopped**. SurrealDB's RocksDB / SurrealKV engines are
  single-process; the import will refuse to start otherwise.
- You have a writeable copy of the v1 user-data tree available locally.

## Steps

```sh
# 0. Stop the v2 daemon if it's up.
robin mcp stop

# 1. Back up the v1 user-data (safe-by-default — the migrator never writes to v1,
#    but the snapshot is worth having in case you decide to roll back later).
tar -czf ~/robin-v1-final-$(date -u +%Y%m%dT%H%M%SZ).tar.gz \
  -C <parent-of-v1-user-data> user-data

# 2. Confirm the v2 schema is current.
cd <v2-checkout>
robin migrate

# 3. Dry-run. No DB writes; produces the import report against an ephemeral
#    in-memory DB so you can review counts before committing.
robin import-v1 --src <path-to-v1-user-data> --dry-run

# 4. Real run. Default `--embed=sync` runs the embedding backfill at the end,
#    so `recall` works as soon as the command returns.
robin import-v1 --src <path-to-v1-user-data>

# 5. Spot-check.
robin recall "<a known v1 fact>"
robin db query "SELECT count() AS n FROM memos WHERE meta.imported_from = 'v1' GROUP ALL;"

# 6. Re-start the daemon and re-register your MCP host.
robin mcp start
```

## What the report tells you

The final report prints to stdout and is also written to
`<robin_home>/cache/v1-import-report-<sessionId>.json`. Key fields:

- **`counts.entities` / `memos` / `edges` / `events` / `rules` etc.** — totals
  written for each kind.
- **`counts.memos_skipped` / `events_skipped`** — content_hash matches from
  a prior run (zero on a fresh import).
- **`breakdown_events`** / **`breakdown_edges`** — sub-totals by source / kind.
- **`warnings.unresolved_link`** — `LINKS.md` rows where one endpoint isn't in
  the DB after Pass B. Expected if LINKS.md references skipped views. Investigate
  only if it's a large fraction of the file.
- **`warnings.long_content_chunked`** — files split into multiple memo chunks
  because they exceeded the embedder's context window.
- **`warnings.undated_event`** — `streams/inbox.md` entries without parseable
  dates. The migrator used the file mtime instead.
- **`errors`** — anything that aborted a single record. Re-runs skip already-imported
  rows via content_hash, so re-running after a code fix is safe.

## Idempotency model

- **Re-run with no v1 changes:** every writer skips. Counts on the report show
  zero "created". Total runtime is dominated by markdown parsing (a few seconds).
- **Re-run after editing a v1 file:** the new payload hashes differently. The
  migrator creates a fresh memo and writes a `supersedes` edge from the new
  memo to the old; `fn::freshness` then zeroes the old row's score so it falls
  out of recall ranking. Both rows remain in the DB.
- **Re-run after deleting a v1 file:** the v2 row stays. The migrator is
  one-directional; deletions don't propagate. Remove manually if needed.
- **Mid-pass crash:** transactional writers leave at most a completed pair
  (row + ledger entry). Re-run resumes via the unique content_hash index.

## Rollback

```sh
robin import-v1 --rollback                  # rolls back the most recent session
robin import-v1 --rollback --session <ULID> # rolls back a specific session
```

- Deletes every target record from the session's ledger entries.
  Cascade-on-delete edge triggers wipe associated edges.
- Deletes the ledger rows themselves.
- Leaves `<robin_home>/sources/` filesystem copies in place — remove manually
  with `rm -rf` if desired.
- Reports per-kind counts of what was deleted.

The migrator is **read-only** against v1; nothing in v1's user-data is ever
touched. Rollback only affects v2.

## What gets skipped (and how to override)

These v1 files are not imported by default because they're auto-generated views
in v1 (re-derivable in v2):

- `memory/{INDEX,MANIFEST,LINKS,ENTITIES,hot,tasks}.md`
  (LINKS and ENTITIES are parsed for signal; only their *content* is skipped)
- `memory/profile/{INDEX,people,relationships}.md`

Pass `--include-views` to override and import them as memos anyway.

These v1 directories are skipped entirely (already projected into current memory or
not relevant to v2):

- `archive/20260508-222124/`, `archive/20260509-150134-pre-empty/` (pre-cutover
  snapshots in v1's user-data root, not `memory/archive/` which IS imported)
- `memory.surrealdb-era/` (leftover from a prior era)
- `runtime/`, `backup/`, `upload/`, `skills/`, `artifacts/`

## Edge cases you might hit

- **Daemon running**: `daemon is running. Stop it first: robin mcp stop`.
- **`--src` path invalid**: the migrator auto-detects whether you point at
  `user-data/` or `user-data/memory/`. If neither shape has an `INDEX.md` at
  the expected location, it refuses with a clear error.
- **Embedder unavailable during `--embed=sync`**: Pass G logs the error and
  exits non-zero; the row writes from Passes A–F still succeed. Re-run after
  the embedder comes back, or run `robin embeddings backfill` manually.
- **Source files reference broken paths**: memos still write; the warning
  `warnings.missing_source` reports the affected files.
