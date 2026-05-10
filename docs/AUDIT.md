# Audit & rework after `robin migrate-from-v1`

After the initial cutover, run an audit pass. The migrator is built so this is easy and **never destroys native data** (anything captured natively in v2 has no `meta.from_v1` and is filtered out of every reset path).

## Status + failures

```
robin migrate-from-v1 --status
robin migrate-from-v1 --show-failures
robin migrate-from-v1 --show-failures --phase capture
```

## DB query primer

Open a SurrealQL session against the daemon (or use a future db-browser). Common audits:

```surql
-- Everything that came from v1, by table
SELECT meta.from_v1.v1_table AS src, count() FROM events GROUP BY src ORDER BY src;

-- Migrated entities by mapped v2 type
SELECT type, count() FROM entities WHERE meta.from_v1.source_hash IS NOT NONE GROUP BY type;

-- Find rows the embedder choked on
SELECT id, content FROM events WHERE meta.embed_failed = true;

-- Backfill progress (count of un-embedded rows)
SELECT count() FROM events WHERE embedding IS NONE AND meta.embed_failed IS NOT true;

-- Trace a specific v1 record forward
SELECT * FROM events WHERE meta.from_v1.v1_id = 'capture:abc123xyz';

-- Captures that didn't get an episode_id
SELECT count() FROM events
  WHERE meta.from_v1.v1_table = 'capture' AND episode_id IS NONE;

-- Lossy-archival events that probably want manual reshape
SELECT meta.kind, count() FROM events
  WHERE meta.kind IN [
    'v1_preference', 'v1_correction', 'v1_learning_question',
    'v1_communication_style', 'v1_domain_confidence',
    'v1_depends_on', 'v1_relates_to', 'v1_supersedes', 'v1_cites', 'v1_produces', 'v1_knows'
  ]
  GROUP BY meta.kind ORDER BY count DESC;
```

## Selective rework

Reset one phase, fix the mapping in `src/migrate-v1/phases/<phase>.js`, re-run:

```
robin migrate-from-v1 --reset --phase entity --dry-run    # preview cascade
robin migrate-from-v1 --reset --phase entity              # confirm at prompt
robin migrate-from-v1 --source ~/workspace/robin/robin-assistant --phase entity
```

`--reset --phase entity` cascades through dependent edges + lossy v1-edge events automatically.

## Custom rework script

Export the v1→v2 ID map and run a one-off transform without touching the migrator:

```
robin migrate-from-v1 --export-mappings ./mappings.json
cp scripts/audit-fixup.js.example scripts/audit-fixup.js
# edit scripts/audit-fixup.js
node scripts/audit-fixup.js
```

See `scripts/audit-fixup.js.example` for the expected shape.
