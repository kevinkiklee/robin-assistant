import type { Migration } from './types.ts';

/**
 * Structured, machine-checkable resolution spec for predictions (design
 * docs/design/2026-10-03-prediction-specs.md). ~80% of predictions were stamped
 * 'unverifiable' at deadline because nothing read Robin's own data to resolve
 * them. `spec` is a nullable JSON object — {source, metric, op, threshold, at?,
 * key?, agg?, window_days?} — that the deterministic resolver
 * (brain/cognition/predictions/resolve-spec.ts) evaluates before dream's
 * unverifiable sweep. `resolution_source` records who resolved a row
 * ('auto:<source>' for the resolver, 'dream:no-spec' for the sweep; NULL for
 * hand resolutions and legacy rows). Both nullable: existing rows are untouched.
 */
export const migration039: Migration = {
  version: 39,
  name: 'prediction-spec',
  up: (db) => {
    db.exec(`ALTER TABLE predictions ADD COLUMN spec TEXT;`);
    db.exec(`ALTER TABLE predictions ADD COLUMN resolution_source TEXT;`);
  },
};
