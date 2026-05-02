// Migration 0021: reorganize user-data layout. See
// docs/superpowers/specs/2026-05-01-user-data-reorg-design.md
//
// Idempotent: re-running after partial application completes safely.
// Reversible via down().

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createHelpers } from '../scripts/lib/migration-helpers.js';

export const id = '0021-reorganize-user-data';
export const description = 'Reorganize user-data into memory/, sources/, and ops/.';

export async function up({ workspaceDir }) {
  // implementation in subsequent tasks
}

export async function down({ workspaceDir }) {
  // implementation in subsequent tasks
}
