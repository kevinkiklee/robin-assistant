import type { Migration } from './types.ts';

/**
 * How many times the SDK auto-compacted the conversation during an agent run.
 * Compaction is invisible to the caller — `runAgent` still returns `success`
 * and the row looks normal — yet after it fires the model works from a short
 * summary instead of the prompt. The nightly critique degraded silently for
 * two weeks this way (2026-08-05 → 08-19: a ~157k-token prompt on a model the
 * bundled SDK treated as 200k). Recording the count makes the reliability
 * audit able to flag it. Default 0 so rows from older code paths stay valid.
 */
export const migration037: Migration = {
  version: 37,
  name: 'agent-usage-compactions',
  up: (db) => {
    db.exec(`ALTER TABLE agent_usage ADD COLUMN compactions INTEGER NOT NULL DEFAULT 0;`);
  },
};
