import { migration001 } from './001-initial.ts';
import type { Migration } from './types.ts';

export const allMigrations: Migration[] = [migration001];
export { applyMigrations } from './runner.ts';
export type { Migration } from './types.ts';
