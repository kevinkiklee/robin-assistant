// Migration 0025: rename `agentsmd` → `claudemd` in user-data manifest.
//
// Robin v5.0.0 hard-cut to Claude Code only and renamed the manifest field
// `agentsmd.hardRulesHash` → `claudemd.hardRulesHash`. The runtime path
// (manifest-snapshot.js, check-manifest.js) was updated at v5.0.0 but the
// loader and scaffold still wrote the old key, so existing user manifests
// may have either field — or both.
//
// This migration:
//   - If only `agentsmd` exists, renames it to `claudemd` (preserves values).
//   - If only `claudemd` exists, no-op.
//   - If both exist, prefers `claudemd` (the new name) and drops `agentsmd`.
//
// Idempotent. Atomic write via tmp + rename.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0025-rename-agentsmd-to-claudemd';
export const description =
  'Rename manifest field `agentsmd` → `claudemd` in user-data/runtime/security/manifest.json (v5.0.0 follow-up).';

export async function up({ workspaceDir }) {
  const manifestPath = join(workspaceDir, 'user-data', 'runtime', 'security', 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log(`[${id}] ${manifestPath} not found — no-op`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.warn(`[${id}] manifest unreadable (${err.message}) — no-op`);
    return;
  }

  const hasOld = Object.prototype.hasOwnProperty.call(manifest, 'agentsmd');
  const hasNew = Object.prototype.hasOwnProperty.call(manifest, 'claudemd');

  if (!hasOld) {
    console.log(`[${id}] no \`agentsmd\` field — no-op`);
    return;
  }

  if (!hasNew) {
    manifest.claudemd = manifest.agentsmd;
  }
  delete manifest.agentsmd;

  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  renameSync(tmp, manifestPath);

  console.log(`[${id}] renamed agentsmd → claudemd in ${manifestPath}`);
}
