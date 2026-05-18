// install.user_data_writable
//
// Surfaces filesystem-level problems (permissions, disk full) before they
// silently corrupt invariants-state.json or any other runtime artifact.

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../../config/data-store.js';

function probeWrite(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const tmp = join(targetDir, `.probe.${process.pid}.${Date.now()}.tmp`);
  const final = `${tmp}.final`;
  writeFileSync(tmp, 'probe', { mode: 0o644 });
  renameSync(tmp, final);
  unlinkSync(final);
}

export default {
  name: 'install.user_data_writable',
  level: 'critical',
  surface: 'install',
  phase: 'paths',
  description: 'user-data/runtime/ is writable (tmpfile probe).',

  remediation: [
    'check disk space: `df -h`',
    'check permissions: `ls -la user-data/runtime/`',
    'verify the volume hosting user-data is mounted',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: false },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async check() {
    try {
      const target = dirname(paths.data.invariantsState());
      probeWrite(target);
      return { ok: true, evidence: { dir: target } };
    } catch (e) {
      return { ok: false, error: e.code ?? e.message ?? 'write_probe_failed' };
    }
  },

  // No automatic repair: surfaces filesystem-level problems that need user action
  // (permissions, disk full, mount missing).

  explain(lastResult) {
    const lines = [
      '### `install.user_data_writable`',
      '',
      '**Symptom.** Invariant state file fails to update; integration syncs silently drop writes; daemon logs file-system errors.',
      '',
      '**Cause.** `user-data/runtime/` is not writable — filesystem permissions, full disk, or the volume was unmounted.',
      '',
      '**Fix.** Investigate the filesystem directly. Check `df -h`, `ls -la user-data/runtime/`, and the volume mount state. No auto-repair: a wrong filesystem state needs human eyes.',
    ];
    if (lastResult?.error) lines.push('', `**Probe error:** \`${lastResult.error}\``);
    return lines.join('\n');
  },
};
