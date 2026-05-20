import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDb } from '../../brain/memory/db.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { runImport } from './import.ts';

function makeNdjson(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

describe('robin import', () => {
  let tmpRoot: string;
  let dataDir: string;
  let importDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'robin-import-test-'));
    dataDir = join(tmpRoot, 'user-data');
    importDir = join(tmpRoot, 'imports');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(importDir, { recursive: true });
    process.env.ROBIN_USER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.ROBIN_USER_DATA_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports missing files without failing', async () => {
    const report = await runImport({ dir: importDir });
    assert.equal(report.errors.length, 0);
    for (const f of Object.values(report.files)) {
      assert.equal(f.missing, true);
    }
  });

  it('imports entities and edges with v2-style record IDs', async () => {
    writeFileSync(
      join(importDir, 'entities.ndjson'),
      makeNdjson([
        { id: 'entities:person__kevin', type: 'person', name: 'Kevin' },
        { id: 'entities:topic__robin', type: 'topic', name: 'Robin' },
      ]),
    );
    writeFileSync(
      join(importDir, 'edges.ndjson'),
      makeNdjson([
        // Entity-entity edge: should land.
        {
          id: 'edges:a',
          in: 'entities:person__kevin',
          out: 'entities:topic__robin',
          kind: 'works_on',
        },
        // Event endpoint: should be skipped, not crash.
        { id: 'edges:b', in: 'events:x123', out: 'entities:topic__robin', kind: 'mentions' },
        // Dangling entity: should be skipped.
        { id: 'edges:c', in: 'entities:person__kevin', out: 'entities:nonexistent', kind: 'knows' },
      ]),
    );

    const report = await runImport({ dir: importDir });
    assert.equal(report.files['entities.ndjson']?.inserted, 2);
    assert.equal(report.files['edges.ndjson']?.inserted, 1);
    assert.equal(report.files['edges.ndjson']?.skipped, 2);

    const db = openDb(dbFilePath(dataDir));
    const rels = db.prepare('SELECT predicate FROM relations').all() as Array<{
      predicate: string;
    }>;
    db.close();
    assert.equal(rels.length, 1);
    assert.equal(rels[0]?.predicate, 'works_on');
  });

  it('imports events into events + events_content with kind synthesis', async () => {
    writeFileSync(
      join(importDir, 'events.ndjson'),
      makeNdjson([
        {
          id: 'events:1',
          ts: '2026-05-19T10:00:00Z',
          source: 'conversation',
          content: 'hello',
          meta: { host: 'claude-code' },
        },
        {
          id: 'events:2',
          ts: '2026-05-19T10:01:00Z',
          source: 'integration',
          content: 'tick',
        },
      ]),
    );

    const report = await runImport({ dir: importDir });
    assert.equal(report.files['events.ndjson']?.inserted, 2);

    const db = openDb(dbFilePath(dataDir));
    const events = db
      .prepare('SELECT kind, source, content_ref FROM events ORDER BY ts')
      .all() as Array<{
      kind: string;
      source: string;
      content_ref: number | null;
    }>;
    assert.equal(events[0]?.kind, 'conversation.claude-code');
    assert.equal(events[1]?.kind, 'v2.integration');
    const bodies = db.prepare('SELECT body FROM events_content ORDER BY id').all() as Array<{
      body: string;
    }>;
    db.close();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.body, 'hello');
  });

  it('respects --limit per file', async () => {
    writeFileSync(
      join(importDir, 'entities.ndjson'),
      makeNdjson([
        { id: 'entities:a', type: 't', name: 'a' },
        { id: 'entities:b', type: 't', name: 'b' },
        { id: 'entities:c', type: 't', name: 'c' },
      ]),
    );
    const report = await runImport({ dir: importDir, limit: 2 });
    assert.equal(report.files['entities.ndjson']?.inserted, 2);
  });

  it('--dry-run does not persist rows', async () => {
    writeFileSync(
      join(importDir, 'entities.ndjson'),
      makeNdjson([{ id: 'entities:a', type: 't', name: 'a' }]),
    );
    const report = await runImport({ dir: importDir, dryRun: true });
    assert.equal(report.files['entities.ndjson']?.inserted, 1);

    const db = openDb(dbFilePath(dataDir));
    const rows = db.prepare('SELECT id FROM entities').all();
    db.close();
    assert.equal(rows.length, 0);
  });

  it('--kinds filters which files run', async () => {
    writeFileSync(
      join(importDir, 'entities.ndjson'),
      makeNdjson([{ id: 'entities:a', type: 't', name: 'a' }]),
    );
    writeFileSync(
      join(importDir, 'events.ndjson'),
      makeNdjson([{ ts: '2026-05-19T10:00:00Z', source: 's', content: 'c' }]),
    );
    const report = await runImport({ dir: importDir, kinds: ['entities'] });
    assert.equal(report.files['entities.ndjson']?.inserted, 1);
    assert.equal(report.files['events.ndjson'], undefined);
  });
});
