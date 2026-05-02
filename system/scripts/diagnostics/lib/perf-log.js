// system/scripts/diagnostics/lib/perf-log.js
//
// Append one line per slow-path hook event. Cap file to N lines via Dream rotation.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PERF_LOG = 'user-data/runtime/state/hook-perf.log';

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

export function appendPerfLog(workspaceDir, { hook, duration_ms, reason }) {
  const file = join(workspaceDir, PERF_LOG);
  ensureDir(file);
  const ts = new Date().toISOString();
  appendFileSync(file, `${ts}\t${hook}\t${duration_ms}\t${reason}\n`);
}

export function capPerfLog(workspaceDir, maxLines = 1000) {
  const file = join(workspaceDir, PERF_LOG);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= maxLines) return;
  const kept = lines.slice(-maxLines).join('\n') + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, kept);
  renameSync(tmp, file);
}
