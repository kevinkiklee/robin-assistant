// close-stale-episodes.js — Theme 1b. Heartbeat-invokable: closes episodes
// whose last_event_at exceeds the per-source idle threshold.

import { surql } from 'surrealdb';

const DEFAULTS = {
  'claude-code': 360,
  gemini: 360,
  integration: 1440,
  default_source: 720,
};

export async function closeStaleEpisodes(db) {
  let cfg = DEFAULTS;
  try {
    const [rows] = await db
      .query('SELECT VALUE value.idle_minutes_by_source FROM runtime:`episode.config`')
      .collect();
    if (rows?.[0]) cfg = { ...DEFAULTS, ...rows[0] };
  } catch {}
  let closed = 0;
  for (const [source, minutes] of Object.entries(cfg)) {
    if (source === 'default_source') continue;
    try {
      const cutoff = new Date(Date.now() - minutes * 60_000);
      const [r] = await db
        .query(
          surql`UPDATE episodes SET ended_at = time::now()
                WHERE ended_at IS NONE
                  AND source = ${source}
                  AND last_event_at < ${cutoff}
                RETURN BEFORE`,
        )
        .collect();
      closed += r?.length ?? 0;
    } catch (e) {
      console.warn(`[close-stale-episodes ${source}] ${e.message}`);
    }
  }
  return { closed };
}
