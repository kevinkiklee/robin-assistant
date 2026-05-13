import { surql } from 'surrealdb';

// Fields the markdown frontmatter is authoritative for at UPSERT.
// `enabled` is NOT in this list — it's DB-authoritative after row creation.
const MD_AUTHORITATIVE = [
  'schedule',
  'runtime',
  'catch_up',
  'notify',
  'notify_on_failure',
  'timeout_minutes',
  'manually_runnable',
  'scheduler_driven',
];

export async function listAllJobs(db) {
  const [rows] = await db.query(surql`SELECT * FROM runtime_jobs`);
  return rows ?? [];
}

export async function getJob(db, name) {
  const [rows] = await db.query(surql`SELECT * FROM runtime_jobs WHERE name = ${name}`);
  return rows?.[0] ?? null;
}

export async function upsertFromDiscovered(db, discovered) {
  for (const job of discovered) {
    const existing = await getJob(db, job.name);
    if (!existing) {
      // Build from MD_AUTHORITATIVE so new fields land in one place. Skip
      // undefined so a partial migration (column not yet defined) doesn't
      // fail the SCHEMAFULL INSERT — this is what produced the
      // "Found field 'scheduler_driven', but no such field exists" failures
      // in jobs-runner runs bi6rjtk7o/bwdombt7n/etc.
      const row = {
        name: job.name,
        enabled: job.enabled,
        consecutive_failures: 0,
        in_flight: false,
        updated_at: new Date(),
      };
      for (const k of MD_AUTHORITATIVE) {
        if (job[k] !== undefined) row[k] = job[k];
      }
      await db.query(surql`CREATE runtime_jobs CONTENT ${row}`);
      continue;
    }
    const patch = { updated_at: new Date() };
    for (const k of MD_AUTHORITATIVE) {
      if (job[k] !== undefined) patch[k] = job[k];
    }
    await db.query(surql`UPDATE runtime_jobs MERGE ${patch} WHERE name = ${job.name}`);
  }
}

export async function garbageCollect(db, presentNames) {
  const rows = await listAllJobs(db);
  for (const r of rows) {
    if (!presentNames.has(r.name) && r.enabled !== false) {
      await db.query(
        surql`UPDATE runtime_jobs MERGE ${{ enabled: false, updated_at: new Date() }} WHERE name = ${r.name}`,
      );
    }
  }
}

export async function setEnabled(db, name, enabled) {
  await db.query(
    surql`UPDATE runtime_jobs MERGE ${{ enabled, updated_at: new Date() }} WHERE name = ${name}`,
  );
}

export async function setInFlight(db, name, in_flight) {
  await db.query(
    surql`UPDATE runtime_jobs MERGE ${{ in_flight, updated_at: new Date() }} WHERE name = ${name}`,
  );
}

export async function setNextRunAt(db, name, next_run_at) {
  await db.query(
    surql`UPDATE runtime_jobs MERGE ${{ next_run_at, updated_at: new Date() }} WHERE name = ${name}`,
  );
}

export async function recordSuccess(db, name, { duration_ms, next_run_at }) {
  const patch = {
    last_run_at: new Date(),
    last_run_ok: true,
    last_error: undefined, // undefined → NONE in SurrealDB driver (null doesn't clear option<string>)
    last_duration_ms: duration_ms,
    consecutive_failures: 0,
    in_flight: false,
    next_run_at,
    updated_at: new Date(),
  };
  await db.query(surql`UPDATE runtime_jobs MERGE ${patch} WHERE name = ${name}`);
}

export async function recordFailure(db, name, { error, duration_ms, next_run_at }) {
  const existing = await getJob(db, name);
  const patch = {
    last_run_at: new Date(),
    last_run_ok: false,
    last_error: String(error).slice(0, 2000),
    last_duration_ms: duration_ms,
    consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
    in_flight: false,
    next_run_at,
    updated_at: new Date(),
  };
  await db.query(surql`UPDATE runtime_jobs MERGE ${patch} WHERE name = ${name}`);
}
