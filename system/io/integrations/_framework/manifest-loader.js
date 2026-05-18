import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCadence } from './cadence.js';

// `loadManifests` runs every time the invariants runner ticks (heartbeat
// reloads per-integration invariants via the manifest scan). Without
// per-process dedupe, the same "integration X: skipped — env required"
// warning fires on every tick and floods daemon.log. Track which
// (warning-key) we have already emitted so each warning surfaces once per
// daemon lifetime — long enough to be noticed, short enough to be cleared
// by a restart.
const _warnedOnce = new Set();
function warnOnce(key, message) {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  console.warn(message);
}

// Test seam — lets unit tests reset the dedupe set without resetting the
// whole module graph.
export function _resetManifestLoaderWarnings() {
  _warnedOnce.clear();
}

const VALID_AUTH_KINDS = new Set(['oauth2-google', 'api-key', 'discord-bot']);
const VALID_CAPTURE_MODES = new Set(['insert-or-skip', 'upsert']);

function deriveKind(m, cadence_ms) {
  if (cadence_ms !== null && m.sync) return 'sync';
  if (cadence_ms === null && m.start) return 'gateway';
  if (cadence_ms === null && !m.start && (m.tools?.length ?? 0) > 0) return 'tool-only';
  return 'invalid';
}

export function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest must be an object');
  if (!m.name || typeof m.name !== 'string') throw new Error('manifest.name required (string)');
  let cadence_ms;
  if (m.cadence === null || m.cadence === undefined) {
    cadence_ms = null;
  } else {
    cadence_ms = parseCadence(m.cadence);
  }
  // `auth` is the legacy Phase 2d field (kept for one transition cycle); the
  // new model declares `secrets.env_keys: string[]`. At least one of the two
  // must be present so we can still classify the auth kind.
  if (m.auth && !VALID_AUTH_KINDS.has(m.auth.kind)) {
    throw new Error(`manifest.auth.kind must be one of: ${[...VALID_AUTH_KINDS].join(', ')}`);
  }
  const capture_mode = m.capture_mode ?? 'insert-or-skip';
  if (!VALID_CAPTURE_MODES.has(capture_mode)) {
    throw new Error(`manifest.capture_mode must be one of: ${[...VALID_CAPTURE_MODES].join(', ')}`);
  }
  const env_keys = Array.isArray(m.secrets?.env_keys) ? m.secrets.env_keys : [];
  const kind = deriveKind(m, cadence_ms);
  if (kind === 'invalid') {
    throw new Error(
      `manifest ${m.name}: cannot determine integration kind (need sync OR start OR tools[])`,
    );
  }
  let quiet_window = null;
  if (m.quiet_window != null) {
    const qw = m.quiet_window;
    if (
      typeof qw !== 'object' ||
      typeof qw.tz !== 'string' ||
      !Array.isArray(qw.active_hours) ||
      qw.active_hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)
    ) {
      throw new Error(
        'manifest.quiet_window must be { tz: string, active_hours: number[] } with hours in [0,23]',
      );
    }
    quiet_window = { tz: qw.tz, active_hours: [...qw.active_hours] };
  }
  return {
    name: m.name,
    cadence_ms,
    kind,
    embed: m.embed ?? true,
    capture_mode,
    auth: m.auth ?? null,
    secrets: { env_keys },
    tools: m.tools ?? [],
    sync: m.sync,
    start: m.start,
    stop: m.stop,
    preflight: typeof m.preflight === 'function' ? m.preflight : null,
    config: m.config ?? {},
    quiet_window,
    write_semantics: m.write_semantics ?? null,
  };
}

export async function loadManifests(dirs) {
  // Accept either a single string (legacy) or an array of dirs.
  const dirList = typeof dirs === 'string' ? [dirs] : dirs;
  const loaded = [];
  const unavailable = [];
  const seen = new Map(); // name → index in `loaded`
  for (let i = 0; i < dirList.length; i += 1) {
    const integrationsDir = dirList[i];
    const source = i === 0 ? 'system' : 'user-data';
    let entries;
    try {
      entries = await readdir(integrationsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('_')) continue;
      const manifestPath = join(integrationsDir, ent.name, 'manifest.js');
      // Directories under integrations/ that lack a manifest.js are shared
      // support code (discord helpers, imessage SQLite reader, etc.) that
      // happens to live inside the integrations namespace because user-data/
      // integrations import from them. They're not broken integrations —
      // they're not integrations at all. Skip silently instead of warning
      // every daemon-lifetime, which used to surface in `robin doctor` as
      // false "integration X: Cannot find module" breakage.
      try {
        await stat(manifestPath);
      } catch {
        continue;
      }
      let validated;
      try {
        const mod = await import(manifestPath);
        validated = validateManifest(mod.manifest ?? mod.default);
      } catch (e) {
        // Real failure: manifest.js exists but won't import or validate.
        // Warn once and move on so one broken manifest can't stop the
        // others from loading.
        warnOnce(`invalid:${ent.name}:${e.message}`, `integration ${ent.name}: ${e.message}`);
        continue;
      }
      validated._source = source;
      validated._dir = join(integrationsDir, ent.name);
      if (typeof validated.preflight === 'function') {
        try {
          await validated.preflight();
        } catch (e) {
          unavailable.push({ name: validated.name, error: e.message, source });
          warnOnce(
            `skipped:${validated.name}:${e.message}`,
            `integration ${validated.name}: skipped — ${e.message}`,
          );
          continue;
        }
      }
      const prev = seen.get(validated.name);
      if (prev !== undefined) {
        warnOnce(
          `collision:${validated.name}:${source}`,
          `integration ${validated.name}: collision (already in ${loaded[prev]._source}); using ${source}`,
        );
        loaded[prev] = validated; // last-write wins; iteration is system → user-data, so user-data wins
      } else {
        seen.set(validated.name, loaded.length);
        loaded.push(validated);
      }
    }
  }
  return { loaded, unavailable };
}
