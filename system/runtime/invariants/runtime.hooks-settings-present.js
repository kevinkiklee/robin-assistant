// runtime.hooks_settings_present
//
// The single biggest catch the framework adds. Without this invariant,
// hooks drift in ~/.claude/settings.json silently — intuition stops
// injecting, biographer stops running on Stop, and Robin "feels less
// helpful" with no error path.
//
// Verifies each expected (host, phase, command) tuple is present. The
// repair re-invokes the existing idempotent installHooksToSettings.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { packageRootDir } from '../../config/data-store.js';
import { installHooksToSettings } from '../install/hooks-settings.js';

// Mirrors hooks-settings.js. If that file's HOSTS/PHASES tables change, this
// must follow — covered by the registry-audit pattern (a missing host here
// will surface as a perpetual fail in production rather than a silent miss).
const EXPECTED = [
  {
    name: 'claude',
    settingsRel: '.claude/settings.json',
    phases: [
      { phase: 'PreToolUse', matcher: 'Bash', subcommand: 'discretion' },
      { phase: 'UserPromptSubmit', matcher: null, subcommand: 'intuition' },
      { phase: 'SessionStart', matcher: null, subcommand: 'session-start' },
      { phase: 'Stop', matcher: null, subcommand: 'stop' },
    ],
  },
  {
    name: 'gemini',
    settingsRel: '.gemini/settings.json',
    phases: [
      { phase: 'PreToolUse', matcher: 'Bash', subcommand: 'discretion' },
      { phase: 'SessionStart', matcher: null, subcommand: 'session-start' },
      { phase: 'Stop', matcher: null, subcommand: 'stop' },
    ],
  },
];

function shimPathFor(pkgRoot) {
  return join(pkgRoot, 'system', 'bin', 'robin-hook.sh');
}

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isCommandPresent(settings, phase, command) {
  const arr = settings?.hooks?.[phase];
  if (!Array.isArray(arr)) return false;
  return arr.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === command));
}

export default {
  name: 'runtime.hooks_settings_present',
  // Initially warn during stage-4 soak. Promote to critical after 7 days
  // of clean check() behavior across instances (see spec §7 stage 4).
  level: 'warn',
  surface: 'runtime',
  phase: 'runtime',
  description: 'Robin\'s SessionStart/Stop/UserPromptSubmit/PreToolUse hooks are present in ~/.claude/settings.json and ~/.gemini/settings.json.',

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 5 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  // Enabled even when settings files don't exist — that itself is a failure.
  // The invariant skips a host's check only if the host's parent directory
  // is absent (e.g., user doesn't use gemini-cli at all). When BOTH host
  // directories are absent, the invariant returns enabled=false.
  async enabled() {
    const home = homedir();
    return EXPECTED.some((h) => existsSync(join(home, h.settingsRel.split('/')[0])));
  },

  async check() {
    const home = homedir();
    const shim = shimPathFor(packageRootDir());
    const missing = [];
    const present = [];

    for (const host of EXPECTED) {
      const hostDir = join(home, host.settingsRel.split('/')[0]);
      if (!existsSync(hostDir)) continue; // host not configured — skip
      const path = join(home, host.settingsRel);
      const settings = readJsonOrNull(path);
      for (const def of host.phases) {
        const command = `${shim} ${def.subcommand}`;
        if (settings && isCommandPresent(settings, def.phase, command)) {
          present.push({ host: host.name, phase: def.phase });
        } else {
          missing.push({ host: host.name, phase: def.phase, command });
        }
      }
    }

    if (missing.length === 0) {
      return { ok: true, evidence: { present: present.length } };
    }
    return {
      ok: false,
      error: 'hooks_missing',
      evidence: { missing, present: present.length },
    };
  },

  async repair(ctx) {
    if (ctx?.dryRun) {
      return { repaired: false, action: 'would_reinstall_hooks' };
    }
    try {
      const result = await installHooksToSettings({
        homeDir: homedir(),
        packageRoot: packageRootDir(),
      });
      const added = Object.values(result?.addedByHost ?? {}).reduce((a, b) => a + b, 0);
      return { repaired: added > 0, action: 'reinstalled_hooks', evidence: { added, byHost: result?.addedByHost } };
    } catch (e) {
      return { repaired: false, error: e.message ?? 'reinstall_failed' };
    }
  },

  explain(lastResult) {
    const lines = [
      '### `runtime.hooks_settings_present`',
      '',
      '**Symptom.** Robin "feels less helpful" — intuition stops injecting `<!-- relevant memory -->` blocks, biographer stops running on Stop, discretion stops gating risky bash. No error message; the agent simply doesn\'t do these things.',
      '',
      '**Cause.** `~/.claude/settings.json` (and/or `~/.gemini/settings.json`) had its hook entries removed — usually because the user edited the file manually, or because Claude Code itself rewrote it from an in-memory copy.',
      '',
      '**Fix.** Invariant calls `installHooksToSettings`, which is already idempotent. The repair only re-adds missing entries — it does not modify or remove other hook entries the user maintains.',
      '',
      '**B-flag (B-4):** self-installing hooks at SessionStart would drop this invariant to detection-only. Performance budget for SessionStart self-verify must be measured first.',
    ];
    if (lastResult?.evidence?.missing?.length) {
      lines.push('', `**Missing:** ${lastResult.evidence.missing.map((m) => `${m.host}/${m.phase}`).join(', ')}`);
    }
    return lines.join('\n');
  },
};
