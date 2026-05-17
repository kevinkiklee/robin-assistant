// self-improvement-v2.js — runtime:self-improvement-v2 feature flag reader/writer.
//
// Single gate for all v2 substrate surfaces: introspection faculty, new dream
// steps, MCP tools, and inject-path playbook fetch.  Defaults to false so the
// v2 code paths are dark until deliberately enabled at the end of Phase 1.
//
// Pattern mirrors runtime:biographer / runtime:embedder readers elsewhere in
// the codebase (SELECT VALUE value … with sensible defaults when row absent).

const DEFAULTS = Object.freeze({
  enabled: false,
});

// Returns boolean: true only when the flag row exists and value.enabled === true.
export async function isSelfImprovementV2Enabled(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`self-improvement-v2`')
      .collect();
    const v = rows?.[0];
    if (!v || typeof v !== 'object') return false;
    return v.enabled === true;
  } catch {
    return false;
  }
}

// Upserts the flag.  Pass enabled=true to open v2 surfaces, false to close them.
export async function setSelfImprovementV2Enabled(db, enabled) {
  await db
    .query(`UPSERT runtime:\`self-improvement-v2\` SET value.enabled = ${enabled === true}`)
    .collect();
}

// Returns the full config object for inspection, with defaults applied.
export async function getSelfImprovementV2Config(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`self-improvement-v2`')
      .collect();
    const v = rows?.[0];
    if (!v || typeof v !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...v };
  } catch {
    return { ...DEFAULTS };
  }
}
