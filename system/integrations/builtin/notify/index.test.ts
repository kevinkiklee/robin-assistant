import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { integration as notify } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-notify-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('notify: health is OK', async () => {
  const db = freshDb();
  const ctx = buildContext('notify', db, null);
  const h = await notify.health!(ctx);
  assert.equal(h.ok, true);
  closeDb(db);
});

test('notify: has no tick (event-driven only)', () => {
  assert.equal(notify.tick, undefined);
});
