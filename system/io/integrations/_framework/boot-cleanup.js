import { surql } from 'surrealdb';

export async function resetInFlightFlags(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  if (!rows[0]) return { reset: 0 };
  const value = rows[0].value ?? {};
  const integrations = value.integrations ?? {};
  let reset = 0;
  const BOOT_RESET_MARKER = '[boot-reset: in_flight cleared]';
  for (const name of Object.keys(integrations)) {
    if (integrations[name].in_flight) {
      integrations[name].in_flight = false;
      const prior = integrations[name].last_sync_error;
      // Avoid leading-space artifact when prior was null, and avoid stacking
      // the marker if a prior boot-reset already left one.
      if (!prior) {
        integrations[name].last_sync_error = BOOT_RESET_MARKER;
      } else if (!prior.includes(BOOT_RESET_MARKER)) {
        integrations[name].last_sync_error = `${prior} ${BOOT_RESET_MARKER}`;
      }
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
