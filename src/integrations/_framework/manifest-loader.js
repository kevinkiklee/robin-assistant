import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCadence } from './cadence.js';

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
    config: m.config ?? {},
  };
}

export async function loadManifests(integrationsDir) {
  let entries;
  try {
    entries = await readdir(integrationsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('_')) continue;
    const manifestPath = join(integrationsDir, ent.name, 'manifest.js');
    try {
      const mod = await import(manifestPath);
      const validated = validateManifest(mod.manifest ?? mod.default);
      out.push(validated);
    } catch (e) {
      console.warn(`integration ${ent.name}: ${e.message}`);
    }
  }
  return out;
}
