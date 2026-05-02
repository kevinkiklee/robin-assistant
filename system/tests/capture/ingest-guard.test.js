import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isIngestDestinationAllowed,
  assertIngestDestinationAllowed,
  listForbiddenPaths,
  IngestForbiddenError,
} from '../../scripts/capture/ingest-guard.js';

test('every forbidden path throws on assert', () => {
  for (const path of listForbiddenPaths()) {
    assert.throws(() => assertIngestDestinationAllowed(path), IngestForbiddenError);
  }
});

test('every forbidden path returns false from check', () => {
  for (const path of listForbiddenPaths()) {
    assert.equal(isIngestDestinationAllowed(path), false);
  }
});

test('allowed paths pass without throwing', () => {
  const allowed = [
    'user-data/memory/knowledge/movies/inception.md',
    'user-data/memory/knowledge/email/inbox-snapshot.md',
    'user-data/memory/knowledge/sources/letterboxd-2026-04-30.md',
    'user-data/memory/streams/journal.md',
    'user-data/memory/LINKS.md',
    'user-data/memory/streams/inbox.md',
    'user-data/memory/profile/personality.md',  // not identity.md
  ];
  for (const path of allowed) {
    assert.doesNotThrow(() => assertIngestDestinationAllowed(path));
    assert.equal(isIngestDestinationAllowed(path), true);
  }
});

test('absolute paths matching a forbidden tail are still rejected', () => {
  assert.throws(
    () => assertIngestDestinationAllowed('/Users/iser/workspace/robin/robin-assistant/user-data/memory/tasks.md'),
    IngestForbiddenError
  );
});

test('windows-style backslashes are normalized', () => {
  assert.throws(
    () => assertIngestDestinationAllowed('user-data\\memory\\tasks.md'),
    IngestForbiddenError
  );
});

test('IngestForbiddenError carries path and code', () => {
  try {
    assertIngestDestinationAllowed('user-data/memory/tasks.md');
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof IngestForbiddenError);
    assert.equal(e.path, 'user-data/memory/tasks.md');
    assert.match(e.message, /INGEST_FORBIDDEN_DESTINATION/);
  }
});

test('error message guides toward the workaround', () => {
  try {
    assertIngestDestinationAllowed('user-data/memory/streams/decisions.md');
    assert.fail('expected throw');
  } catch (e) {
    assert.match(e.message, /direct edit, not ingest/);
  }
});
