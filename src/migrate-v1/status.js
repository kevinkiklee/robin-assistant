import { listFailures } from './failures.js';

export async function printStatus(db, log = console.log) {
  const [progRows] = await db
    .query(`SELECT * FROM type::record('runtime', 'migration_progress')`)
    .collect();
  const p = progRows[0]?.value?.v1_to_v2 ?? null;
  if (!p) {
    log('no migration in progress');
    return;
  }
  log(`migration started: ${p.started_at}`);
  log(`completed phases : ${(p.completed_phases ?? []).join(', ') || '(none)'}`);
  log(`current phase    : ${p.current_phase ?? '(none)'}`);
  for (const [ph, c] of Object.entries(p.counts ?? {})) {
    log(`  ${ph.padEnd(20)} imported=${c.imported}  dup=${c.dup}  skipped=${c.skipped}`);
  }
  for (const [ph, cur] of Object.entries(p.cursor ?? {})) {
    if (cur?.last_v1_id) log(`  cursor[${ph}] = ${cur.last_v1_id}`);
  }
  const failures = await listFailures(db);
  log(`failures recorded: ${failures.length}`);
}
