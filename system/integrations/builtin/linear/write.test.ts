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
  lookupByRef,
  upsertMap,
} from './map.ts';

describe('linear write idempotency', () => {
  let db: RobinDb;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'robin-write-'));
    db = openDb(join(tmpDir, 'test.db'));
    applyMigrations(db, allMigrations);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('robin_ref map lookup finds existing issue', () => {
    upsertMap(db, {
      robin_ref: 'gh:notif-500',
      linear_issue_id: 'issue-abc',
      identifier: 'ENG-99',
      team_id: 'team-eng',
      last_action: 'create',
    });
    const row = lookupByRef(db, 'gh:notif-500');
    assert.ok(row, 'map row should exist for robin_ref');
    assert.equal(row.linear_issue_id, 'issue-abc');
    assert.equal(row.identifier, 'ENG-99');
  });

  it('isSatisfied blocks re-creation for completed refs', () => {
    upsertMap(db, {
      robin_ref: 'auto:done-1',
      linear_issue_id: 'issue-done',
      last_state_type: 'completed',
      last_action: 'transition',
    });
    assert.equal(isSatisfied(db, 'auto:done-1'), true, 'completed ref should be satisfied');

    // A write action would check isSatisfied before creating — simulating that logic:
    const shouldCreate = !isSatisfied(db, 'auto:done-1');
    assert.equal(shouldCreate, false, 'should NOT create a new issue for a satisfied ref');
  });

  it('isSatisfied blocks re-creation for cancelled refs', () => {
    upsertMap(db, {
      robin_ref: 'auto:cancel-1',
      linear_issue_id: 'issue-cancel',
      last_state_type: 'cancelled',
      last_action: 'transition',
    });
    assert.equal(isSatisfied(db, 'auto:cancel-1'), true);
  });

  it('isSatisfied allows creation for open refs', () => {
    upsertMap(db, {
      robin_ref: 'auto:open-1',
      linear_issue_id: 'issue-open',
      last_state_type: 'started',
      last_action: 'create',
    });
    // An existing row with non-terminal state: isSatisfied is false, but lookupByRef
    // will still find it — so create_issue would skip with "already mapped" reason.
    assert.equal(isSatisfied(db, 'auto:open-1'), false);
    const existing = lookupByRef(db, 'auto:open-1');
    assert.ok(existing, 'should still find existing map row');
  });

  it('isSatisfied returns false for unknown refs', () => {
    assert.equal(isSatisfied(db, 'nonexistent:ref'), false);
  });

  it('comment-level dedup via hasCommentedRef / addCommentedRef', () => {
    upsertMap(db, {
      robin_ref: 'issue:ref-1',
      linear_issue_id: 'issue-1',
      last_action: 'create',
    });

    // First comment ref
    assert.equal(hasCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0523'), false);
    const added = addCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0523');
    assert.equal(added, true, 'first add should succeed');
    assert.equal(hasCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0523'), true);

    // Duplicate add returns false
    const addedAgain = addCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0523');
    assert.equal(addedAgain, false, 'duplicate add should return false');

    // Different comment ref on the same issue
    assert.equal(hasCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0524'), false);
    addCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0524');
    assert.equal(hasCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0524'), true);
    // Original still tracked
    assert.equal(hasCommentedRef(db, 'issue:ref-1', 'comment:daily-brief-0523'), true);
  });

  it('hasCommentedRef returns false for unknown issue ref', () => {
    assert.equal(hasCommentedRef(db, 'no:such:ref', 'c1'), false);
  });

  it('addCommentedRef returns false for unknown issue ref', () => {
    assert.equal(addCommentedRef(db, 'no:such:ref', 'c1'), false);
  });

  it('upsertMap after create tracks the issue for transition', () => {
    // Simulating the create_issue path: upsertMap on create
    upsertMap(db, {
      robin_ref: 'workflow:1',
      linear_issue_id: 'issue-wf',
      identifier: 'ENG-200',
      team_id: 'team-eng',
      last_state_type: 'unstarted',
      last_action: 'create',
    });

    // Then transition updates the map
    upsertMap(db, {
      robin_ref: 'workflow:1',
      linear_issue_id: 'issue-wf',
      last_state_type: 'completed',
      last_action: 'transition',
    });

    const row = lookupByRef(db, 'workflow:1');
    assert.ok(row);
    assert.equal(row.last_state_type, 'completed');
    assert.equal(row.last_action, 'transition');
    // identifier and team_id should be preserved (COALESCE in upsert)
    assert.equal(row.identifier, 'ENG-200');
    assert.equal(row.team_id, 'team-eng');
    assert.equal(isSatisfied(db, 'workflow:1'), true);
  });
});
