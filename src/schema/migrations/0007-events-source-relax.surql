-- Phase 2d (cont.): allow integration-named sources on events.
--
-- Migration 0001 pinned `source` to a fixed enum suited to v1's capture
-- surface (cli, stop_hook, manual, sync, biographer, ingest, discord,
-- migration). Phase 2d adds first-class integrations (gmail, lunch_money,
-- discord, etc.), each writing rows via `ctx.capture()` with its own source
-- string. Validation moves from the schema to the integration framework
-- (manifest.name → row.source); keep the index for query performance but
-- drop the ASSERT.
--
-- Also relax `content_hash` to optional. The capture helper hashes
-- `content` before writing for embedding-cache hits, but a future framework
-- variant may write rows without one (e.g. binary blobs); the schema should
-- not block that.

REMOVE FIELD source ON events;
DEFINE FIELD source ON events TYPE string ASSERT string::len($value) > 0;

REMOVE FIELD content_hash ON events;
DEFINE FIELD content_hash ON events TYPE option<string>;
