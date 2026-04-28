// Migration 0005: introduce the unified job system.
//   - Move system/operations/* to system/jobs/* with added frontmatter fields.
//   - Write new system jobs (_robin-sync, backup) that didn't exist as ops.
//   - Delete legacy launchd template.
//   - Move legacy dream.lock path.
//   - Update references in AGENTS.md and system/manifest.md.
//
// Idempotent: re-running has no effect.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const id = '0005-job-system';
export const description = 'Unify operations and jobs; introduce job runner system.';

// Per the design doc.
const JOB_DEFAULTS = {
  dream: { runtime: 'agent', schedule: '0 4 * * *', enabled: true, catch_up: true, timeout_minutes: 30, notify_on_failure: true },
  'morning-briefing': { runtime: 'agent', schedule: '0 7 * * *', enabled: false, catch_up: true, timeout_minutes: 15, notify_on_failure: true },
  'weekly-review': { runtime: 'agent', schedule: '0 10 * * 0', enabled: false, catch_up: true, timeout_minutes: 30, notify_on_failure: true },
  'monthly-financial': { runtime: 'agent', schedule: '0 9 1 * *', enabled: false, catch_up: true, timeout_minutes: 30, notify_on_failure: true },
  'quarterly-self-assessment': { runtime: 'agent', schedule: '0 9 1 1,4,7,10 *', enabled: false, catch_up: true, timeout_minutes: 30, notify_on_failure: true },
  'subscription-audit': { runtime: 'agent', schedule: '0 9 15 * *', enabled: false, catch_up: true, timeout_minutes: 15, notify_on_failure: true },
  // Operations without a natural cadence — kept as triggerable agent protocols (no schedule).
  'email-triage': { runtime: 'agent', enabled: false, timeout_minutes: 15 },
  'meeting-prep': { runtime: 'agent', enabled: false, timeout_minutes: 15 },
  'receipt-tracking': { runtime: 'agent', enabled: false, timeout_minutes: 15 },
  'todo-extraction': { runtime: 'agent', enabled: false, timeout_minutes: 15 },
  'system-maintenance': { runtime: 'agent', enabled: false, timeout_minutes: 30 },
  ingest: { runtime: 'agent', enabled: false, timeout_minutes: 15 },
  lint: { runtime: 'agent', enabled: false, timeout_minutes: 15 },
  'multi-session-coordination': { runtime: 'agent', enabled: false, timeout_minutes: 5 },
  'save-conversation': { runtime: 'agent', enabled: false, timeout_minutes: 10 },
};

function parseSimpleFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fmRaw: '', fmLines: [], body: content };
  return { fmRaw: m[1], fmLines: m[1].split('\n'), body: m[2] };
}

function buildFrontmatter(fmLines, defaults) {
  const present = new Set();
  for (const line of fmLines) {
    const k = (line.match(/^([\w-]+):/) || [])[1];
    if (k) present.add(k);
  }
  const out = [...fmLines];
  for (const [k, v] of Object.entries(defaults)) {
    if (present.has(k)) continue;
    if (typeof v === 'string') out.push(`${k}: "${v}"`);
    else out.push(`${k}: ${v}`);
  }
  return out.join('\n');
}

function migrateOperationsToJobs(workspaceDir) {
  const opsDir = join(workspaceDir, 'system/operations');
  const jobsDir = join(workspaceDir, 'system/jobs');
  if (!existsSync(opsDir)) return { moved: [] };
  mkdirSync(jobsDir, { recursive: true });
  const moved = [];
  for (const f of readdirSync(opsDir)) {
    if (!f.endsWith('.md')) continue;
    if (f === 'INDEX.md') continue;
    const name = f.slice(0, -3);
    const src = join(opsDir, f);
    const dst = join(jobsDir, f);
    if (existsSync(dst)) continue; // idempotent
    const content = readFileSync(src, 'utf-8');
    const { fmLines, body } = parseSimpleFrontmatter(content);
    const defaults = JOB_DEFAULTS[name] || { runtime: 'agent', enabled: false };
    const newFm = buildFrontmatter(fmLines, defaults);
    writeFileSync(dst, `---\n${newFm}\n---\n${body}`);
    unlinkSync(src);
    moved.push(name);
  }
  // Drop the legacy INDEX.md and the directory if empty.
  const legacyIndex = join(opsDir, 'INDEX.md');
  if (existsSync(legacyIndex)) unlinkSync(legacyIndex);
  if (existsSync(opsDir) && readdirSync(opsDir).length === 0) rmSync(opsDir, { recursive: true, force: true });
  return { moved };
}

function writeSystemJob(workspaceDir, filename, content) {
  const dst = join(workspaceDir, 'system/jobs', filename);
  if (existsSync(dst)) return false;
  mkdirSync(join(workspaceDir, 'system/jobs'), { recursive: true });
  writeFileSync(dst, content);
  return true;
}

const ROBIN_SYNC_BODY = `---
name: _robin-sync
description: Reconciler heartbeat — picks up new/removed jobs and re-installs scheduler entries.
runtime: node
enabled: true
schedule: "15 */6 * * *"
command: node system/scripts/jobs/reconciler.js
catch_up: false
timeout_minutes: 1
notify_on_failure: false
---

Heartbeat that runs every 6 hours. Reads system/jobs/ and user-data/jobs/,
diffs against currently installed scheduler entries, and applies the delta.

Idempotent. Hash-based early-exit when nothing has changed (sub-10ms in the
common case). Also regenerates INDEX.md, upcoming.md, and failures.md and
cleans up orphaned per-job state files.
`;

const BACKUP_JOB_BODY = `---
name: backup
description: Daily snapshot of user-data/ to backup/.
runtime: node
enabled: true
schedule: "0 3 * * *"
command: node system/scripts/backup.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Snapshots user-data/ into a timestamped folder under backup/.
`;

function dropLegacyLaunchd(workspaceDir) {
  const p = join(workspaceDir, 'system/launchd/com.robin.fetch-finances.plist');
  if (existsSync(p)) {
    unlinkSync(p);
    const dir = join(workspaceDir, 'system/launchd');
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {}
    return true;
  }
  return false;
}

function moveLegacyDreamLock(workspaceDir) {
  const oldP = join(workspaceDir, 'user-data/state/locks/dream.lock');
  const newP = join(workspaceDir, 'user-data/state/jobs/locks/dream.lock');
  if (!existsSync(oldP)) return false;
  mkdirSync(join(workspaceDir, 'user-data/state/jobs/locks'), { recursive: true });
  if (!existsSync(newP)) renameSync(oldP, newP);
  else unlinkSync(oldP);
  return true;
}

function updateAgentsMd(workspaceDir) {
  const p = join(workspaceDir, 'AGENTS.md');
  if (!existsSync(p)) return false;
  let content = readFileSync(p, 'utf-8');
  let changed = false;
  // Replace "system/operations/" path references with "system/jobs/"
  if (content.includes('system/operations/')) {
    content = content.replace(/system\/operations\//g, 'system/jobs/');
    changed = true;
  }
  // Replace "On-demand workflows invoked by trigger phrases. Full list in `system/operations/INDEX.md`."
  content = content.replace(
    /Full list in `system\/jobs\/INDEX\.md`\./,
    'Full list in `system/jobs/` and `user-data/state/jobs/INDEX.md`.'
  );
  if (changed) writeFileSync(p, content);
  return changed;
}

function updateManifestMd(workspaceDir) {
  const p = join(workspaceDir, 'system/manifest.md');
  if (!existsSync(p)) return false;
  let content = readFileSync(p, 'utf-8');
  if (!content.includes('system/operations/')) return false;
  content = content.replace(/system\/operations\//g, 'system/jobs/');
  writeFileSync(p, content);
  return true;
}

export async function up({ workspaceDir }) {
  const result = {
    movedOps: [],
    newSystemJobs: [],
    droppedLaunchd: false,
    movedDreamLock: false,
    updatedAgents: false,
    updatedManifest: false,
  };

  const moved = migrateOperationsToJobs(workspaceDir);
  result.movedOps = moved.moved;

  if (writeSystemJob(workspaceDir, '_robin-sync.md', ROBIN_SYNC_BODY)) {
    result.newSystemJobs.push('_robin-sync');
  }
  if (writeSystemJob(workspaceDir, 'backup.md', BACKUP_JOB_BODY)) {
    result.newSystemJobs.push('backup');
  }

  result.droppedLaunchd = dropLegacyLaunchd(workspaceDir);
  result.movedDreamLock = moveLegacyDreamLock(workspaceDir);
  result.updatedAgents = updateAgentsMd(workspaceDir);
  result.updatedManifest = updateManifestMd(workspaceDir);

  const summary = [];
  if (result.movedOps.length) summary.push(`migrated ${result.movedOps.length} operations to system/jobs/`);
  if (result.newSystemJobs.length) summary.push(`added ${result.newSystemJobs.join(', ')}`);
  if (result.droppedLaunchd) summary.push(`removed legacy launchd template`);
  if (result.movedDreamLock) summary.push(`moved dream.lock to user-data/state/jobs/locks/`);
  if (result.updatedAgents) summary.push(`updated AGENTS.md`);
  if (result.updatedManifest) summary.push(`updated system/manifest.md`);
  if (summary.length > 0) console.log(`[0005] ${summary.join('; ')}.`);
}
