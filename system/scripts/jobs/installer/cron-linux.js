// Linux cron adapter. User's other crontab entries are preserved by the
// managed-block markers; we never touch lines outside the block.

import { spawnSync } from 'node:child_process';

export const BEGIN_MARKER = '# === robin-jobs managed block — do not edit by hand ===';
export const END_MARKER = '# === end robin-jobs managed block ===';

function getCrontab() {
  const r = spawnSync('crontab', ['-l'], { stdio: 'pipe' });
  if (r.status === 0) return r.stdout.toString();
  // exit 1 + "no crontab" message → return empty
  return '';
}

function setCrontab(content) {
  const r = spawnSync('crontab', ['-'], { input: content, stdio: 'pipe' });
  return { ok: r.status === 0, stderr: r.stderr?.toString() || '' };
}

export function buildManagedBlock({ jobs, robinPath, workspaceDir, generatedAt = new Date() }) {
  const lines = [BEGIN_MARKER];
  lines.push(`# Generated ${generatedAt.toISOString()}`);
  lines.push(`ROBIN_WORKSPACE=${workspaceDir}`);
  lines.push(`PATH=/usr/local/bin:/usr/bin:/bin`);
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled === false) continue;
    if (!def.frontmatter.schedule) continue;
    const command = `${robinPath} run ${name}`;
    lines.push(`${def.frontmatter.schedule} ${command}`);
  }
  lines.push(END_MARKER);
  return lines.join('\n') + '\n';
}

export function replaceManagedBlock(existing, newBlock) {
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) {
    return (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + newBlock;
  }
  // Trim leading newline before the begin marker if any, replace through end marker line.
  const before = existing.slice(0, beginIdx).replace(/\n+$/, '');
  const afterStart = existing.indexOf('\n', endIdx);
  const after = afterStart >= 0 ? existing.slice(afterStart + 1) : '';
  return (before ? before + '\n' : '') + newBlock + (after ? after : '');
}

export function removeManagedBlock(existing) {
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) return existing;
  const before = existing.slice(0, beginIdx).replace(/\n+$/, '');
  const afterStart = existing.indexOf('\n', endIdx);
  const after = afterStart >= 0 ? existing.slice(afterStart + 1) : '';
  return (before ? before + '\n' : '') + (after ? after : '');
}

export function syncAll({ jobs, robinPath, workspaceDir }) {
  const existing = getCrontab();
  const block = buildManagedBlock({ jobs, robinPath, workspaceDir });
  const updated = replaceManagedBlock(existing, block);
  if (updated === existing) return { ok: true, changed: false };
  const r = setCrontab(updated);
  return { ...r, changed: true };
}

export function uninstallAll() {
  const existing = getCrontab();
  const updated = removeManagedBlock(existing);
  if (updated === existing) return { ok: true, changed: false };
  return { ...setCrontab(updated), changed: true };
}

export function listEntries() {
  const existing = getCrontab();
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin === -1 || end === -1) return [];
  const block = existing.slice(begin, end);
  const names = [];
  for (const line of block.split('\n')) {
    const m = line.match(/\srun\s+(\S+)\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

export function isHealthy() {
  const probe = spawnSync('sh', ['-c', 'systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || true'], { stdio: 'pipe' });
  const out = probe.stdout?.toString().trim() || '';
  return out === 'active';
}
