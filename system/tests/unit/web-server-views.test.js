// Coverage for the view-aggregate endpoints added in the M4 build-out:
//   /api/view/dashboard, /api/view/search, /api/view/entity,
//   /api/jobs, /api/integrations, POST /api/rule/:id,
//   layered table groupings in /api/info,
//   /api/table/:name pagination params.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { __test__, makeWebServer } from '../../runtime/web/server.js';

const { tableLayer } = __test__;

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function listenEphemeral(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('tableLayer groups tables by architectural layer', () => {
  assert.equal(tableLayer('events'), 'L1');
  assert.equal(tableLayer('episodes'), 'L2');
  assert.equal(tableLayer('entities'), 'L3');
  assert.equal(tableLayer('edges'), 'L3');
  assert.equal(tableLayer('rules'), 'L4');
  assert.equal(tableLayer('rule_candidates'), 'L4');
  assert.equal(tableLayer('biographer_telemetry'), 'TEL');
  assert.equal(tableLayer('telemetry_hourly'), 'TEL');
  assert.equal(tableLayer('embeddings_gemini_3072_events'), 'EMB');
  assert.equal(tableLayer('_migrations'), 'OP');
  assert.equal(tableLayer('archive_log'), 'OP');
  assert.equal(tableLayer('runtime_jobs'), 'OP');
  assert.equal(tableLayer('frob'), 'OTHER');
});

test('GET /api/info includes layer groupings', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/info`);
    const data = await r.json();
    assert.ok(Array.isArray(data.layers));
    const ids = data.layers.map((l) => l.id);
    // Should at least include L1 (events) and L3 (entities).
    assert.ok(ids.includes('L1'), `expected L1, got ${ids.join(',')}`);
    const l1 = data.layers.find((l) => l.id === 'L1');
    assert.ok(l1.tables.includes('events'));
    assert.ok(typeof l1.label === 'string' && l1.label.length > 0);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/view/dashboard returns aggregated snapshot', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE events SET source = 'whoop', content = 'r1', meta = { kind: 'recovery' }").collect();
    await db.query("CREATE events SET source = 'gmail', content = 'r2', meta = { kind: 'inbox' }").collect();
    const r = await fetch(`${base}/api/view/dashboard`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(d.counts);
    assert.ok(Array.isArray(d.layers));
    assert.ok(Array.isArray(d.recent));
    assert.equal(d.recent.length, 2);
    assert.ok(d.needs_input);
    assert.equal(typeof d.needs_input.pending_rules, 'number');
    assert.ok(d.fetched_at);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/view/search finds entities by name substring', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE entities:kevin SET name = 'Kevin', type = 'person'").collect();
    await db.query("CREATE entities:jake SET name = 'Jake', type = 'person'").collect();
    const r = await fetch(`${base}/api/view/search?q=kev`);
    const d = await r.json();
    assert.ok(Array.isArray(d.rows));
    assert.equal(d.rows.length, 1);
    assert.equal(d.rows[0].name, 'Kevin');
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/view/entity returns profile with edges + captures', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE entities:kevin SET name = 'Kevin', type = 'person'").collect();
    const r0 = await db.query("CREATE events SET source = 'gmail', content = 'hi'").collect();
    const eventId = r0?.[0]?.[0]?.id;
    // Events↔entities go through the edges relation table, not an inline
    // events.entities field.
    await db.query(`RELATE ${eventId}->edges->entities:kevin SET kind = 'mentions'`).collect();
    const r = await fetch(`${base}/api/view/entity?id=entities%3Akevin`);
    const d = await r.json();
    assert.ok(d.entity);
    assert.equal(d.entity.name, 'Kevin');
    assert.ok(Array.isArray(d.captures));
    assert.equal(d.captures.length, 1);
    assert.ok(Array.isArray(d.edges));
    assert.ok(d.edges.length >= 1);
    assert.ok(Array.isArray(d.episodes));
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/view/entity rejects bad ids', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/view/entity?id=NOT_AN_ID`);
    const d = await r.json();
    assert.match(d.error, /bad entity id/);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/jobs returns runtime_jobs snapshot', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/jobs`);
    const d = await r.json();
    assert.ok(Array.isArray(d.rows));
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/integrations returns map (empty when unset)', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/integrations`);
    const d = await r.json();
    assert.equal(typeof d.integrations, 'object');
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/table/:name honors limit + offset', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    for (let i = 0; i < 5; i += 1) {
      await db.query(`CREATE events SET source = 'whoop', content = 'r${i}'`).collect();
    }
    const r = await fetch(`${base}/api/table/events?limit=2&offset=0`);
    const d = await r.json();
    assert.equal(d.recent.length, 2);
    assert.equal(d.limit, 2);
    assert.equal(d.offset, 0);
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/rule/:id approves a candidate', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    // Synthesize a candidate using the actual rule_candidates schema:
    // requires `content`, `kind` (enum), `confidence` (0..1), `status` (enum).
    await db.query("CREATE rule_candidates:c1 SET kind = 'profile_update', content = 'try this', confidence = 0.7, status = 'pending'").collect();
    const r = await fetch(`${base}/api/rule/rule_candidates%3Ac1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    const d = await r.json();
    assert.equal(d.status, 'approved');
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/actions lists action_trust rows', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE action_trust SET class = 'discord_send:send_dm', state = 'AUTO', set_by = 'user', success_count = 3, correction_count = 0, last_state_change_at = time::now()").collect();
    const r = await fetch(`${base}/api/actions`);
    const d = await r.json();
    assert.ok(Array.isArray(d.rows));
    assert.equal(d.rows.length, 1);
    assert.equal(d.rows[0].state, 'AUTO');
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/actions/:cls flips trust state', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE action_trust SET class = 'discord_send:send_dm', state = 'ASK', set_by = 'default', success_count = 0, correction_count = 0, last_state_change_at = time::now()").collect();
    const r = await fetch(`${base}/api/actions/${encodeURIComponent('discord_send:send_dm')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'AUTO', reason: 'always-ok' }),
    });
    const d = await r.json();
    assert.equal(d.state, 'AUTO');
    const [rows] = await db.query("SELECT VALUE state FROM action_trust WHERE class = 'discord_send:send_dm'").collect();
    assert.equal(rows?.[0], 'AUTO');
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/actions/:cls rejects invalid state', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/actions/${encodeURIComponent('discord_send:send_dm')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'YES' }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/doctor returns daemon + invariants + integrations', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/doctor`);
    const d = await r.json();
    assert.ok(d.fetched_at);
    assert.ok(d.daemon); // may have error field if .state file absent (fine)
    assert.ok(d.invariants); // ditto
    assert.equal(typeof d.integrations, 'object');
    assert.ok(Array.isArray(d.in_flight_jobs));
  } finally {
    server.close();
    await close(db);
  }
});

test('GET /api/logs handles missing file gracefully', async () => {
  const db = await fresh();
  const server = makeWebServer({ db });
  const base = await listenEphemeral(server);
  try {
    // ROBIN_HOME is a fresh tmp dir, so daemon.log won't exist.
    const r = await fetch(`${base}/api/logs?lines=10`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(d.lines));
    // Returns error string in body, NOT a 500 — keeps the page resilient.
    assert.equal(d.lines.length, 0);
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/admin/run-job returns 503 without daemon proxy config', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    const r = await fetch(`${base}/api/admin/run-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    });
    assert.equal(r.status, 503);
  } finally {
    server.close();
    await close(db);
  }
});

test('POST /api/rule/:id rejects bad action', async () => {
  const db = await fresh();
  const server = makeWebServer({ db, allowWrites: true, requireCsrf: false });
  const base = await listenEphemeral(server);
  try {
    await db.query("CREATE rule_candidates:c2 SET kind = 'profile_update', content = 's', confidence = 0.5, status = 'pending'").collect();
    const r = await fetch(`${base}/api/rule/rule_candidates%3Ac2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'nuke' }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
    await close(db);
  }
});
