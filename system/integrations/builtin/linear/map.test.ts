import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import {
  addCommentedRef,
  hasCommentedRef,
  isSatisfied,
  lookupByIssueId,
  lookupByRef,
  openMappedIssueIds,
  refreshStateTypes,
  upsertMap,
} from './map.ts';

describe('linear_issue_map', () => {
  let db: RobinDb;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'robin-map-'));
    db = openDb(join(tmpDir, 'test.db'));
    applyMigrations(db, allMigrations);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsert + lookup by ref', () => {
    upsertMap(db, {
      robin_ref: 'github:notifications-403',
      linear_issue_id: 'issue-1',
      identifier: 'ENG-42',
      team_id: 'team-eng',
      last_action: 'create',
    });
    const row = lookupByRef(db, 'github:notifications-403');
    assert.ok(row);
    assert.equal(row.linear_issue_id, 'issue-1');
    assert.equal(row.identifier, 'ENG-42');
    assert.equal(row.last_action, 'create');
  });

  it('upsert updates existing row', () => {
    upsertMap(db, { robin_ref: 'test:1', linear_issue_id: 'a', last_action: 'create' });
    upsertMap(db, { robin_ref: 'test:1', linear_issue_id: 'a', last_state_type: 'started', last_action: 'transition' });
    const row = lookupByRef(db, 'test:1');
    assert.ok(row);
    assert.equal(row.last_state_type, 'started');
    assert.equal(row.last_action, 'transition');
  });

  it('lookup by issue id (reverse)', () => {
    upsertMap(db, { robin_ref: 'x:1', linear_issue_id: 'issue-abc', last_action: 'create' });
    const row = lookupByIssueId(db, 'issue-abc');
    assert.ok(row);
    assert.equal(row.robin_ref, 'x:1');
  });

  it('commented refs tracking', () => {
    upsertMap(db, { robin_ref: 'x:1', linear_issue_id: 'i1', last_action: 'create' });
    assert.equal(hasCommentedRef(db, 'x:1', 'c1'), false);
    assert.equal(addCommentedRef(db, 'x:1', 'c1'), true);
    assert.equal(hasCommentedRef(db, 'x:1', 'c1'), true);
    assert.equal(addCommentedRef(db, 'x:1', 'c1'), false);
  });

  it('isSatisfied returns true for completed/cancelled', () => {
    upsertMap(db, { robin_ref: 'x:done', linear_issue_id: 'i2', last_state_type: 'completed', last_action: 'transition' });
    assert.equal(isSatisfied(db, 'x:done'), true);
    assert.equal(isSatisfied(db, 'x:nonexistent'), false);
  });

  it('refreshStateTypes batch update', () => {
    upsertMap(db, { robin_ref: 'a:1', linear_issue_id: 'i1', last_action: 'create' });
    upsertMap(db, { robin_ref: 'a:2', linear_issue_id: 'i2', last_action: 'create' });
    refreshStateTypes(db, [
      { linear_issue_id: 'i1', state_type: 'completed' },
      { linear_issue_id: 'i2', state_type: 'started' },
    ]);
    assert.equal(isSatisfied(db, 'a:1'), true);
    assert.equal(isSatisfied(db, 'a:2'), false);
  });

  it('openMappedIssueIds excludes completed', () => {
    upsertMap(db, { robin_ref: 'b:1', linear_issue_id: 'open1', last_action: 'create' });
    upsertMap(db, { robin_ref: 'b:2', linear_issue_id: 'done1', last_state_type: 'completed', last_action: 'create' });
    upsertMap(db, { robin_ref: 'b:3', linear_issue_id: 'open2', last_state_type: 'started', last_action: 'create' });
    const ids = openMappedIssueIds(db);
    assert.ok(ids.includes('open1'));
    assert.ok(ids.includes('open2'));
    assert.ok(!ids.includes('done1'));
  });
});
