import { surql } from 'surrealdb';

export async function resetInFlightFlags(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  if (!rows[0]) return { reset: 0 };
  const value = rows[0].value ?? {};
  const integrations = value.integrations ?? {};
  let reset = 0;
  for (const name of Object.keys(integrations)) {
    if (integrations[name].in_flight) {
      integrations[name].in_flight = false;
      integrations[name].last_sync_error =
        `${integrations[name].last_sync_error ?? ''} [boot-reset: in_flight cleared]`;
      reset += 1;
    }
  }
  if (reset > 0) {
    await db
      .query(
        surql`UPDATE type::record('runtime', 'scheduler') SET value.integrations = ${integrations}`,
      )
      .collect();
  }
  return { reset };
}
