// install.pointer_present
//
// Symptom (from CLAUDE.md runbook):
//   .robin-home install pointer disappears mid-session; CLI commands and
//   `defaultDbUrl()` fail with `Robin is not installed. Run: robin install`.
//   Restart doesn't help.
//
// Cause:
//   Some process (postinstall, --upgrade, or another agent's stale-path scrub)
//   deletes one of the two pointer files. With both files gone, no recovery
//   path remains.
//
// Fix:
//   Maintain both pointer files (<packageRoot>/.robin-home AND OS-native
//   user-config path). If one is missing, copy from the surviving one. If they
//   diverge, prefer .robin-home and rewrite the OS-config pointer to match.
//   If BOTH are missing → no auto-repair (we cannot infer the user-data path);
//   the user must run `robin install`.
//
// B-candidate: B-1 (env-var ROBIN_HOME discovery eliminates this invariant).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { POINTER_VERSION, pointerSearchPaths } from '../../config/data-store.js';

function readPointerFile(p) {
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'not_object' };
    if (parsed.version !== POINTER_VERSION) {
      return { ok: false, error: `version_mismatch:${parsed.version}` };
    }
    if (typeof parsed.home !== 'string' || !parsed.home) {
      return { ok: false, error: 'missing_home' };
    }
    return { ok: true, payload: parsed };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'missing' : e.message ?? 'unreadable' };
  }
}

function writeAtomic(p, payload) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export default {
  name: 'install.pointer_present',
  level: 'critical',
  surface: 'install',
  phase: 'paths',
  description: 'Robin install pointer file exists, parses, and is consistent across primary + fallback locations.',

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 5 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async check() {
    const paths = pointerSearchPaths();
    if (paths.length === 0) {
      return { ok: false, error: 'no_pointer_paths_configured' };
    }
    const reads = paths.map((p) => ({ path: p, read: readPointerFile(p) }));
    const present = reads.filter((r) => r.read.ok);
    const missing = reads.filter((r) => !r.read.ok && r.read.error === 'missing');
    const malformed = reads.filter((r) => !r.read.ok && r.read.error !== 'missing');

    if (present.length === 0) {
      return {
        ok: false,
        error: malformed.length > 0 ? 'all_pointers_unreadable' : 'all_pointers_missing',
        evidence: { paths, reads: reads.map((r) => ({ path: r.path, error: r.read.error })) },
      };
    }

    // Check consistency across surviving pointers.
    const homes = new Set(present.map((r) => r.read.payload.home));
    if (homes.size > 1) {
      return {
        ok: false,
        error: 'pointer_divergence',
        evidence: { paths, homes: [...homes] },
      };
    }

    if (missing.length > 0 || malformed.length > 0) {
      return {
        ok: false,
        error: missing.length > 0 ? 'pointer_partial_missing' : 'pointer_partial_malformed',
        evidence: { canonical: present[0].read.payload.home, missing: missing.map((r) => r.path), malformed: malformed.map((r) => r.path) },
      };
    }

    return { ok: true, evidence: { home: present[0].read.payload.home, paths: paths.length } };
  },

  async repair(ctx) {
    const paths = pointerSearchPaths();
    const reads = paths.map((p) => ({ path: p, read: readPointerFile(p) }));
    const present = reads.filter((r) => r.read.ok);

    if (present.length === 0) {
      return { repaired: false, error: 'no_surviving_pointer; run: robin install' };
    }

    // Canonical = primary (.robin-home, paths[0]) if present, else first survivor.
    const canonical = (reads[0]?.read.ok ? reads[0].read.payload : present[0].read.payload);

    if (ctx?.dryRun) {
      return {
        repaired: false,
        action: 'would_sync_pointers',
        plan: {
          canonical_home: canonical.home,
          targets: reads.filter((r) => !r.read.ok || r.read.payload.home !== canonical.home).map((r) => r.path),
        },
      };
    }

    let writes = 0;
    for (const r of reads) {
      if (r.read.ok && r.read.payload.home === canonical.home) continue;
      try {
        writeAtomic(r.path, canonical);
        writes++;
      } catch (e) {
        return { repaired: false, error: `write_failed:${r.path}:${e.message}` };
      }
    }
    return { repaired: writes > 0, action: 'pointers_synced', writes };
  },

  explain(lastResult) {
    const lines = [
      '### `install.pointer_present`',
      '',
      '**Symptom.** CLI commands and `defaultDbUrl()` fail with `Robin is not installed. Run: robin install`. The daemon log fills with `[scheduler/dispatcher] tick failed: Robin is not installed`. Restarting CLI or daemon does not help.',
      '',
      '**Cause.** Some process — most likely a postinstall pass, `robin install --upgrade`, or another agent\'s "stale-path scrub" — deleted one or both pointer files (`<packageRoot>/.robin-home` and the OS-native fallback `~/Library/Application Support/Robin/install.json`).',
      '',
      '**Fix.** Robin maintains both pointer files. The invariant auto-syncs missing or divergent pointers from the surviving one. If both are missing, the invariant fails critical — restoring requires `robin install`.',
    ];
    if (lastResult?.evidence) {
      lines.push('', '**Current evidence:**', '', '```json', JSON.stringify(lastResult.evidence, null, 2), '```');
    }
    return lines.join('\n');
  },
};
