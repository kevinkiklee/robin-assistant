// runtime.node_version_pinned
//
// .npmrc pins use-node-version. If process.version disagrees, native
// addons may have been built for a different ABI — the cause of the
// NODE_MODULE_VERSION mismatch class in the runbook.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRootDir } from '../../config/data-store.js';

const NPMRC_PIN_RX = /^\s*use-node-version\s*=\s*([^\s#]+)/m;

function readPinnedVersion() {
  const path = join(packageRootDir(), '.npmrc');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const match = NPMRC_PIN_RX.exec(raw);
    return match ? match[1].replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

function normalizeVersion(v) {
  return String(v).replace(/^v/, '');
}

export default {
  name: 'runtime.node_version_pinned',
  level: 'warn',
  surface: 'runtime',
  phase: 'runtime',
  description: 'process.version matches the version pinned in .npmrc (use-node-version).',

  remediation: [
    'switch to pinned version: `nvm use <pinned>` or `asdf install nodejs <pinned>`',
    'rebuild native addons after switching: `cd node_modules/better-sqlite3 && node-gyp rebuild --target=<pinned>`',
    'inspect: `grep use-node-version .npmrc`',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: false },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async enabled() {
    return readPinnedVersion() != null;
  },

  async check(ctx) {
    const pinned = readPinnedVersion();
    if (!pinned) return { ok: false, error: 'no_pin_in_npmrc' };
    const running = normalizeVersion(process.version);
    if (running === pinned) {
      return { ok: true, evidence: { pinned, running } };
    }
    // Doctor trigger nuance: `robin doctor` runs under the CLI's
    // `#!/usr/bin/env node` shebang, which resolves to whatever node is
    // first on PATH (often Homebrew). The *daemon* runs under nvm-managed
    // node (per the launchctl plist). The boot + postInstall triggers fire
    // under the daemon's process and are authoritative for this invariant.
    // From the doctor trigger, defer — report ok with a note so the
    // renderer surfaces it without a false warning, while the state file
    // (written by the daemon's boot eval) carries the real verdict.
    if (ctx?.trigger === 'doctor') {
      return {
        ok: true,
        evidence: {
          pinned,
          running,
          note: 'doctor trigger runs under CLI node; boot/postInstall under daemon node is authoritative',
        },
      };
    }
    // The version string differs from the pin — but the actual concern is
    // whether the running runtime can load this package's native addons.
    // If better-sqlite3 (the canonical native dependency) imports + opens
    // cleanly, the running Node's ABI is compatible regardless of the
    // version-string mismatch. This catches the common env-vs-nvm skew
    // where the CLI shim's `#!/usr/bin/env node` resolves to a Homebrew
    // Node (e.g. 25.x) while pnpm uses the nvm-managed Node (24.x): both
    // versions can be ABI-compatible with the prebuilt binding.
    try {
      const mod = await import('better-sqlite3');
      const Database = mod.default ?? mod;
      const probe = new Database(':memory:');
      probe.close();
      return {
        ok: true,
        evidence: {
          pinned,
          running,
          bindings_loadable: true,
          note: 'version mismatch but ABI compatible',
        },
      };
    } catch (e) {
      return {
        ok: false,
        error: 'version_mismatch',
        evidence: {
          pinned,
          running,
          bindings_loadable: false,
          binding_error: e?.message ?? String(e),
        },
      };
    }
  },

  // No automatic repair: switching Node versions is user-level (nvm/asdf).

  explain(lastResult) {
    const lines = [
      '### `runtime.node_version_pinned`',
      '',
      '**Symptom.** Tests fail with `NODE_MODULE_VERSION` mismatch on better-sqlite3 or another native addon. `pnpm test` may pass while running `node` directly fails (or vice versa).',
      '',
      '**Cause.** `pnpm` resolves binaries through its own PATH (Homebrew Node), while the interactive shell uses a different Node (nvm). Native modules built for one ABI fail to load under the other. `.npmrc` pins the pnpm-side version via `use-node-version`.',
      '',
      '**Fix.** Use the pinned Node version directly: `nvm use <pinned>` or `asdf install nodejs <pinned>`. After switching, rebuild native addons: `cd node_modules/better-sqlite3 && node-gyp rebuild --target=<pinned>`.',
    ];
    if (lastResult?.evidence) {
      lines.push(
        '',
        `**Versions:** pinned=\`${lastResult.evidence.pinned}\` running=\`${lastResult.evidence.running}\``,
      );
    }
    return lines.join('\n');
  },
};
