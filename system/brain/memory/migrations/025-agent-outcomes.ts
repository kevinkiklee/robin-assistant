import type { Migration } from './types.ts';

/**
 * Phase B (agentic outcome loop): structured outcome per agent run.
 *  - outcome:        did-work | no-op | blocked | unparseable (from the envelope)
 *  - impact:         high | medium | low (from the envelope)
 *  - structured_json: the raw structured output, verbatim, for audit
 *  - verified:       verified | outcome-mismatch | unverifiable (deterministic
 *                    post-condition check; NULL when nothing was claimed)
 * The (label, ts) index serves per-handler rollups (metrics --agents) and the
 * consecutive-failure streak query in the agent-runner's benching pass.
 */
export const migration025: Migration = {
  version: 25,
  name: 'agent-outcomes',
  up: (db) => {
    db.exec(`ALTER TABLE agent_usage ADD COLUMN outcome TEXT;`);
    db.exec(`ALTER TABLE agent_usage ADD COLUMN impact TEXT;`);
    db.exec(`ALTER TABLE agent_usage ADD COLUMN structured_json TEXT;`);
    db.exec(`ALTER TABLE agent_usage ADD COLUMN verified TEXT;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_usage_label_ts ON agent_usage(label, ts);`);
  },
};
