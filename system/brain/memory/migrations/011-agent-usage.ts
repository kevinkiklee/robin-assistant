import type { Migration } from './types.ts';

export const migration011: Migration = {
  version: 11,
  name: 'agent-usage',
  up: (db) => {
    // Persistent ledger for Claude Agent SDK runs. Every agentic invocation
    // (dispatcher provider role or `runAgent` primitive) records one row so
    // per-surface daily caps and health surfacing can be computed from history.
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        surface TEXT NOT NULL,
        label TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        subtype TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_usage_ts ON agent_usage(ts);
    `);
  },
};
