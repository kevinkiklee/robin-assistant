// Shared CLAUDE.md / GEMINI.md regeneration path.
//
// Originally lived inline in `mcp-install.js`. Extracted so the hourly
// `refresh-claude-md` internal job and ad-hoc user-data scripts can call the
// same path without re-implementing the DB-fanout + manifest-walk logic.
//
// Idempotency: `refreshAgentsMdFiles` skips writing when the new content
// matches the existing file byte-for-byte, so an hourly-cron run is cheap
// (no mtime churn, no log noise) when nothing changed.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getCommStyle } from '../../cognition/jobs/comm-style.js';
import { listAllJobs } from '../../cognition/jobs/db.js';
import { getCalibration } from '../../cognition/jobs/predictions.js';
import { ensureHome, getIntegrationDirs } from '../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../data/db/client.js';
import { readIntegrationsState } from '../../data/runtime/integrations-state.js';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';
import { agentsMdContent, mergeAgentsMdContent } from './agents-md.js';
import { readCurrentState } from './current-state.js';

async function readOrEmpty(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

export async function loadIntegrationsForAgentsMd({ intState } = {}) {
  try {
    const { loaded } = await loadManifests(getIntegrationDirs());
    return loaded.map((m) => {
      const toolNames = [];
      for (const factory of m.tools ?? []) {
        if (typeof factory !== 'function') continue;
        try {
          const built = factory({});
          if (built?.name) toolNames.push(built.name);
        } catch {
          if (factory.name) toolNames.push(factory.name);
        }
      }
      const source = m._source === 'user-data' ? 'user-data' : 'system';
      // Default to enabled when no state row exists yet (fresh installs). An
      // explicit `false` from runtime:integrations marks the row disabled.
      const enabledState = intState?.states?.[m.name]?.enabled;
      const enabled = enabledState !== false;
      return {
        name: m.name,
        kind: m.kind,
        cadence_ms: m.cadence_ms,
        tool_names: toolNames,
        source,
        enabled,
        write_semantics: m.write_semantics ?? null,
      };
    });
  } catch {
    return [];
  }
}

export async function readDbDataForAgentsMd() {
  try {
    await ensureHome();
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      const jobs = await listAllJobs(db);
      const commStyle = await getCommStyle(db);
      const calibration = await getCalibration(db);
      let intState = null;
      try {
        intState = await readIntegrationsState(db);
      } catch {
        intState = null;
      }
      const integrations = await loadIntegrationsForAgentsMd({ intState });
      const currentState = await readCurrentState(db);
      return { jobs, commStyle, calibration, integrations, currentState };
    } finally {
      await close(db);
    }
  } catch {
    return {
      jobs: undefined,
      commStyle: null,
      calibration: null,
      integrations: [],
      currentState: null,
    };
  }
}

/**
 * Writes (or no-ops) a single AGENTS.md target. Skips the write when content
 * is byte-equal to keep hourly runs idempotent.
 *
 * @returns {{path: string, action: 'wrote' | 'unchanged' | 'created'}}
 */
export async function writeMergedAgentsMd(
  path,
  jobs,
  commStyle,
  calibration,
  integrations,
  currentState,
) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOrEmpty(path);
  const merged = mergeAgentsMdContent(
    existing,
    agentsMdContent({ jobs, commStyle, calibration, integrations, currentState }),
  );
  if (merged === existing) return { path, action: 'unchanged' };
  await writeFile(path, merged, 'utf8');
  return { path, action: existing.length === 0 ? 'created' : 'wrote' };
}

/**
 * Regenerate both ~/.claude/CLAUDE.md and ~/.gemini/GEMINI.md from current
 * DB state. Returns per-path outcomes so callers can log meaningfully.
 */
export async function refreshAgentsMdFiles({ targets } = {}) {
  const home = homedir();
  const paths = targets ?? [join(home, '.claude/CLAUDE.md'), join(home, '.gemini/GEMINI.md')];
  const { jobs, commStyle, calibration, integrations, currentState } =
    await readDbDataForAgentsMd();
  const results = [];
  for (const path of paths) {
    results.push(
      await writeMergedAgentsMd(path, jobs, commStyle, calibration, integrations, currentState),
    );
  }
  return results;
}
