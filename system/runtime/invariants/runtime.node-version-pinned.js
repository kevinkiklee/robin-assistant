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

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: false },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },

  async enabled() {
    return readPinnedVersion() != null;
  },

  async check() {
    const pinned = readPinnedVersion();
    if (!pinned) return { ok: false, error: 'no_pin_in_npmrc' };
    const running = normalizeVersion(process.version);
    if (running === pinned) {
      return { ok: true, evidence: { pinned, running } };
    }
    return {
      ok: false,
      error: 'version_mismatch',
      evidence: { pinned, running },
    };
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
      lines.push('', `**Versions:** pinned=\`${lastResult.evidence.pinned}\` running=\`${lastResult.evidence.running}\``);
    }
    return lines.join('\n');
  },
};
