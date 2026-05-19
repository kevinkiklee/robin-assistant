import type { Migration } from './types.ts';

export const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  up: (db) => {
    db.exec(`
      -- Time-ordered firehose: integration.tick, mcp.tool_call, biographer.extract, ...
      CREATE TABLE events (
        id          INTEGER PRIMARY KEY,
        ts          TEXT NOT NULL,
        kind        TEXT NOT NULL,
        source      TEXT NOT NULL,
        actor       TEXT,
        duration_ms INTEGER,
        status      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        content_ref INTEGER REFERENCES events_content(id) ON DELETE SET NULL
      );
      CREATE INDEX events_ts ON events(ts);
      CREATE INDEX events_kind_ts ON events(kind, ts);
      CREATE INDEX events_source_ts ON events(source, ts);

      -- Content-bearing rows
      CREATE TABLE events_content (
        id        INTEGER PRIMARY KEY,
        ts        TEXT NOT NULL,
        body      TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX events_content_ts ON events_content(ts);

      -- Scheduler queue
      CREATE TABLE jobs (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        trigger_kind  TEXT NOT NULL,  -- 'cron' | 'event' | 'hook' | 'delayed' | 'manual'
        scheduled_at  TEXT NOT NULL,
        leased_until  TEXT,
        claimed_by    TEXT,
        state         TEXT NOT NULL,  -- 'pending' | 'leased' | 'completed' | 'errored'
        retry_count   INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        payload       TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX jobs_state_scheduled ON jobs(state, scheduled_at);

      -- Per-integration KV
      CREATE TABLE integration_state (
        integration_name TEXT NOT NULL,
        key              TEXT NOT NULL,
        value            TEXT NOT NULL,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (integration_name, key)
      );
    `);
  },
};
