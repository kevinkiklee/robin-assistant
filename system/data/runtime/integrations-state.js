import { surql } from 'surrealdb';

/**
 * runtime:integrations record:
 *   value: {
 *     states: { [name]: { enabled: boolean, enabled_at: Date, source: 'system'|'user-data' } },
 *     rev: number,                // monotonic; bumps on every write
 *     migrated_at: Date | null,   // set once by `robin integrations migrate`
 *   }
 *
 * Lives separately from runtime:scheduler because the lifecycles differ
 * (user-action vs dispatcher-action) and combining them creates write
 * contention on every tick.
 */

async function readRaw(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'integrations')`)
    .collect();
  return rows[0]?.value ?? { states: {}, rev: 0, migrated_at: null };
}

export async function readIntegrationsState(db) {
  return await readRaw(db);
}

export async function readIntegrationsRev(db) {
  const v = await readRaw(db);
  return v.rev ?? 0;
}

export async function setIntegrationEnabled(db, name, { enabled, source }) {
  const value = await readRaw(db);
  const states = { ...(value.states ?? {}) };
  states[name] = { enabled: !!enabled, enabled_at: new Date(), source };
  const next = { ...value, states, rev: (value.rev ?? 0) + 1 };
  await db
    .query(surql`UPSERT type::record('runtime', 'integrations') SET value = ${next}`)
    .collect();
  return next;
}

export async function setMigratedAt(db, when = new Date()) {
  const value = await readRaw(db);
  const next = { ...value, migrated_at: when, rev: (value.rev ?? 0) + 1 };
  await db
    .query(surql`UPSERT type::record('runtime', 'integrations') SET value = ${next}`)
    .collect();
  return next;
}

export function isEnabled(state, name) {
  return state?.states?.[name]?.enabled === true;
}
