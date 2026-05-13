// tests/integration/ensure-home-layout.test.js
//
// End-to-end check that ensureHome() ties the migrator + v2 dir set + marker
// write together correctly. Uses $ROBIN_HOME to point at a tmpdir so no real
// state is touched.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function withHome(label) {
  const h = join(
    tmpdir(),
    `robin-ensurehome-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(h, { recursive: true });
  return h;
}

const EXPECTED_V2_DIRS = [
  'artifacts',
  'jobs',
  'skills',
  'sources',
  'upload',
  'config',
  ['config', 'secrets'],
  'cognition',
  ['io', 'publish'],
  ['io', 'sqlite-snapshots'],
  ['data', 'db'],
  ['data', 'snapshots'],
  ['runtime', 'logs'],
  ['runtime', 'daemon'],
  ['runtime', 'install'],
  ['runtime', 'install', 'reports'],
];

test('ensureHome: fresh home creates the full v2 dir set and writes the v2 marker', async () => {
  const home = withHome('fresh');
  process.env.ROBIN_HOME = home;
  try {
    const mod = await import(`../../config/data-store.js?fresh=${Math.random()}`);
    await mod.ensureHome();

    for (const rel of EXPECTED_V2_DIRS) {
      const p = Array.isArray(rel) ? join(home, ...rel) : join(home, rel);
      assert.equal(existsSync(p), true, `expected dir present: ${p}`);
    }

    const markerPath = join(home, 'runtime', 'install', '.marker.json');
    assert.equal(existsSync(markerPath), true, 'v2 marker written');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.user_data_layout_version, 2);
    assert.ok(typeof marker.createdAt === 'string');
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureHome: legacy v1 home triggers migration and ends in v2 shape', async () => {
  const home = withHome('v1');
  process.env.ROBIN_HOME = home;
  try {
    // Minimal v1 layout: legacy marker + a db/ dir with a file.
    writeFileSync(
      join(home, '.robin-data'),
      JSON.stringify({ version: 1, createdAt: '2026-02-02T00:00:00.000Z' }),
    );
    mkdirSync(join(home, 'db'), { recursive: true });
    writeFileSync(join(home, 'db', 'CURRENT'), 'legacy-content');
    mkdirSync(join(home, 'cache', 'logs'), { recursive: true });
    writeFileSync(join(home, 'cache', 'logs', 'biographer.log'), 'old-log');

    const mod = await import(`../../config/data-store.js?v1=${Math.random()}`);
    await mod.ensureHome();

    // db/ moved.
    assert.equal(existsSync(join(home, 'db')), false, 'old db/ removed');
    assert.equal(
      readFileSync(join(home, 'data', 'db', 'CURRENT'), 'utf8'),
      'legacy-content',
      'db content moved into data/db/',
    );

    // log moved.
    assert.equal(
      readFileSync(join(home, 'runtime', 'logs', 'biographer.log'), 'utf8'),
      'old-log',
      'log moved into runtime/logs/',
    );

    // Marker is v2 and preserves createdAt.
    const marker = JSON.parse(
      readFileSync(join(home, 'runtime', 'install', '.marker.json'), 'utf8'),
    );
    assert.equal(marker.user_data_layout_version, 2);
    assert.equal(marker.createdAt, '2026-02-02T00:00:00.000Z');

    // Legacy marker gone.
    assert.equal(existsSync(join(home, '.robin-data')), false);
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureHome: idempotent — second call on v2 home is a no-op', async () => {
  const home = withHome('idem');
  process.env.ROBIN_HOME = home;
  try {
    const mod = await import(`../../config/data-store.js?idem=${Math.random()}`);
    await mod.ensureHome();
    const markerFirst = readFileSync(join(home, 'runtime', 'install', '.marker.json'), 'utf8');
    await mod.ensureHome();
    const markerSecond = readFileSync(join(home, 'runtime', 'install', '.marker.json'), 'utf8');
    assert.equal(markerFirst, markerSecond, 'marker untouched on second call');
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
