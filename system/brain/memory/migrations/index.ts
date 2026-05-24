import { migration001 } from './001-initial.ts';
import { migration002 } from './002-entities-relations.ts';
import { migration003 } from './003-fts.ts';
import { migration004 } from './004-lifecycle.ts';
import { migration005 } from './005-events-vec-4096.ts';
import { migration006 } from './006-biographer-progress.ts';
import { migration007 } from './007-predictions-external-id.ts';
import { migration008 } from './008-linear-issue-map.ts';
import { migration009 } from './009-belief-candidates.ts';
import type { Migration } from './types.ts';

export const allMigrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
];
export { applyMigrations } from './runner.ts';
export type { Migration } from './types.ts';
