import readline from 'node:readline';

// meta.from_v1 is a FLEXIBLE nested object so even rows with `meta: {}` will have
// meta.from_v1 set to an empty object ({} IS NOT NONE → true).  source_hash is
// only written for migrated rows (migration 0009), making it the correct sentinel.
const FILTER = 'meta.from_v1.source_hash IS NOT NONE';

const V1_EDGE_KINDS = `['v1_knows','v1_depends_on','v1_relates_to','v1_supersedes','v1_cites','v1_produces']`;

async function deleteWhere(db, table, extra = '') {
  const where = extra ? `${FILTER} AND ${extra}` : FILTER;
  await db.query(`DELETE FROM ${table} WHERE ${where}`).collect();
}

async function deleteMigratedEdges(db) {
  await db.query(`DELETE FROM mentions WHERE ${FILTER}`).collect();
  await db.query(`DELETE FROM participates_in WHERE ${FILTER}`).collect();
}

async function clearEpisodeIdOnMigratedCaptures(db) {
  await db
    .query(
      `UPDATE events SET episode_id = NONE WHERE episode_id IS NOT NONE AND meta.from_v1.v1_table = 'capture'`,
    )
    .collect();
}

async function count(db, table, where) {
  const [r] = await db
    .query(`SELECT count() AS n FROM ${table} WHERE ${where} GROUP ALL`)
    .collect();
  return r?.[0]?.n ?? 0;
}

async function confirm(promptText) {
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

export async function runReset(db, { phase = null, dryRun = false, prompt = true }) {
  const plan = [];

  if (phase === 'entity') {
    plan.push({
      action: 'edges (mentions + participates_in)',
      count: (await count(db, 'mentions', FILTER)) + (await count(db, 'participates_in', FILTER)),
    });
    plan.push({
      action: 'lossy v1-edge events',
      count: await count(db, 'events', `${FILTER} AND meta.kind IN ${V1_EDGE_KINDS}`),
    });
    plan.push({
      action: 'entities (v1)',
      count: await count(db, 'entities', FILTER),
    });
  } else if (phase === 'episode') {
    plan.push({
      action: 'clear events.episode_id (migrated captures)',
      count: await count(
        db,
        'events',
        `meta.from_v1.v1_table = 'capture' AND episode_id IS NOT NONE`,
      ),
    });
    plan.push({
      action: 'episodes (v1)',
      count: await count(db, 'episodes', FILTER),
    });
  } else if (phase === 'capture') {
    plan.push({
      action: 'edges',
      count: (await count(db, 'mentions', FILTER)) + (await count(db, 'participates_in', FILTER)),
    });
    plan.push({
      action: 'events (capture rows)',
      count: await count(db, 'events', `${FILTER} AND meta.from_v1.v1_table = 'capture'`),
    });
  } else if (phase === 'edges') {
    plan.push({
      action: 'edges only',
      count: (await count(db, 'mentions', FILTER)) + (await count(db, 'participates_in', FILTER)),
    });
  } else if (phase?.startsWith('lossy:')) {
    const table = phase.slice(6);
    plan.push({
      action: `events (kind=v1_${table})`,
      count: await count(db, 'events', `${FILTER} AND meta.kind = 'v1_${table}'`),
    });
  } else if (phase) {
    throw new Error(`unknown reset phase: ${phase}`);
  } else {
    plan.push({ action: 'all v1-migrated rows', count: 'sum across tables' });
    plan.push({ action: 'progress + id_map + failures rows' });
  }

  console.log('Reset plan:');
  for (const p of plan) {
    console.log(`  - ${p.action}${p.count !== undefined ? ` (${p.count})` : ''}`);
  }

  if (dryRun) return { plan, applied: false };

  if (prompt) {
    const a = await confirm('Type "reset" to continue: ');
    if (a !== 'reset') {
      console.log('aborted');
      return { plan, applied: false };
    }
  }

  if (phase === 'entity') {
    await deleteMigratedEdges(db);
    await deleteWhere(db, 'events', `meta.kind IN ${V1_EDGE_KINDS}`);
    await deleteWhere(db, 'entities');
  } else if (phase === 'episode') {
    await clearEpisodeIdOnMigratedCaptures(db);
    await deleteWhere(db, 'episodes');
  } else if (phase === 'capture') {
    await deleteMigratedEdges(db);
    await deleteWhere(db, 'events', `meta.from_v1.v1_table = 'capture'`);
  } else if (phase === 'edges') {
    await deleteMigratedEdges(db);
  } else if (phase?.startsWith('lossy:')) {
    const table = phase.slice(6);
    await deleteWhere(db, 'events', `meta.kind = 'v1_${table}'`);
  } else {
    // full wipe
    await deleteMigratedEdges(db);
    await deleteWhere(db, 'events');
    await deleteWhere(db, 'entities');
    await deleteWhere(db, 'episodes');
    await db.query(`DELETE FROM type::record('runtime', 'migration_progress')`).collect();
    await db.query(`DELETE FROM type::record('runtime', 'migration_id_map')`).collect();
    await db.query(`DELETE FROM type::record('runtime', 'migration_failures')`).collect();
  }

  return { plan, applied: true };
}
