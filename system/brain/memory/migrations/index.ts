import { migration001 } from './001-initial.ts';
import { migration002 } from './002-entities-relations.ts';
import { migration003 } from './003-fts.ts';
import type { Migration } from './types.ts';

export const allMigrations: Migration[] = [migration001, migration002, migration003];
export { applyMigrations } from './runner.ts';
export type { Migration } from './types.ts';
