import { ensureHome, getIntegrationDirs } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import {
  readIntegrationsState,
  setIntegrationEnabled,
} from '../../../data/runtime/integrations-state.js';
import { loadManifests } from '../../../io/integrations/_framework/manifest-loader.js';

/**
 * Pure entry point — receives ctx (db + manifests) and arg names, returns
 * { exitCode, stdout, stderr }. The CLI wrapper (integrationsDisable) calls
 * this after opening the DB and loading manifests.
 */
export async function runDisable(ctx, names) {
  const { db, manifests } = ctx;
  const stdoutLines = [];
  const stderrLines = [];

  // Validate ALL names first (all-or-nothing).
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    const available = manifests.map((m) => m.name).sort().join(', ');
    stderrLines.push(
      `error: integration '${unknown.join("', '")}' not installed; available: ${available}`,
    );
    return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }

  const state = await readIntegrationsState(db);
  for (const name of names) {
    const m = byName.get(name);
    if (state.states?.[name]?.enabled !== true) {
      stdoutLines.push(`${name}: (no change)`);
      continue;
    }
    await setIntegrationEnabled(db, name, { enabled: false, source: m._source ?? 'user-data' });
    stdoutLines.push(`${name}: disabled`);
    if (m.kind === 'gateway' || m.kind === 'tool-only') {
      stdoutLines.push(`${name} is a ${m.kind} integration — restart daemon to apply`);
    }
  }
  return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

export async function integrationsDisable(args = []) {
  if (args.length === 0) {
    console.error('usage: robin integrations disable <name> [<name>…]');
    process.exitCode = 1;
    return;
  }
  await ensureHome();
  const { loaded: manifests } = await loadManifests(getIntegrationDirs());
  const db = await connect({ engine: await defaultDbUrl() });
  try {
    const out = await runDisable({ db, manifests }, args);
    if (out.stdout) console.log(out.stdout);
    if (out.stderr) console.error(out.stderr);
    process.exitCode = out.exitCode;
  } finally {
    await close(db);
  }
}
