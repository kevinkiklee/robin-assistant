// HEALTH_ALERT.md writer.
//
// Renders the subset of invariants whose latest check failed and whose
// repair policy has escalated to 'manual' — i.e. they need human attention
// because auto-repair is no longer trusted (critical-level invariants at
// consecutive_failures ≥ 3, or warn-level invariants whose last repair
// failed). When the set is empty, the file is removed so its presence is
// itself a signal.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { manualAlertSet } from './policy-decisions.js';

function renderEntry(inv, entry) {
  const lines = [];
  lines.push(`## ${inv.name} (${inv.level})`);
  lines.push('');
  if (inv.description) {
    lines.push(`**Why it matters:** ${inv.description}`);
    lines.push('');
  }
  lines.push(`**Consecutive failures:** ${entry.consecutive_failures}`);
  const err = entry.last_result_summary?.error;
  if (err) {
    lines.push(`**Last error:** \`${err}\``);
  }
  lines.push('');
  const remediation = inv.remediation ?? [];
  if (remediation.length) {
    lines.push('**Suggested fix:**');
    lines.push('');
    for (const step of remediation) lines.push(`- \`${step}\``);
    lines.push('');
  }
  if (typeof inv.explain === 'function') {
    try {
      lines.push(inv.explain());
      lines.push('');
    } catch {
      /* explain is decoration, not load-bearing */
    }
  }
  return lines.join('\n');
}

/**
 * Compute the alert set and (re)write HEALTH_ALERT.md.
 *
 * @param {string} alertPath - Absolute path to HEALTH_ALERT.md.
 * @param {object[]} invariants - The registry under evaluation.
 * @param {object} state - The invariants-state snapshot.
 * @returns {{ wrote: boolean, removed: boolean, names: string[] }}
 */
export function writeHealthAlert(alertPath, invariants, state) {
  const alerts = manualAlertSet(invariants, state);
  if (alerts.length === 0) {
    if (existsSync(alertPath)) {
      rmSync(alertPath, { force: true });
      return { wrote: false, removed: true, names: [] };
    }
    return { wrote: false, removed: false, names: [] };
  }
  mkdirSync(dirname(alertPath), { recursive: true });
  const generated = new Date().toISOString();
  const header = [
    '# HEALTH_ALERT',
    '',
    `Generated: ${generated}`,
    '',
    `${alerts.length} invariant${alerts.length === 1 ? '' : 's'} require manual attention. ` +
      'Auto-repair has escalated past its safety floor — investigate before resuming normal use.',
    '',
    '---',
    '',
  ].join('\n');
  const body = alerts.map((inv) => renderEntry(inv, state.invariants[inv.name])).join('\n---\n\n');
  writeFileSync(alertPath, header + body, { mode: 0o644 });
  return { wrote: true, removed: false, names: alerts.map((i) => i.name) };
}
