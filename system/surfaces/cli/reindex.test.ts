import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { runReindex } from './reindex.ts';

// The test mocks the Ollama embed server. We point ROBIN_USER_DATA_DIR at a temp dir
// and seed a models.yaml that uses Ollama against a localhost stub so the reindex pass
// runs against deterministic vectors instead of a real GPU model.

interface StubServer {
  close: () => Promise<void>;
  port: number;
  callCount: () => number;
}

async function startStubOllama(dim = 4096): Promise<StubServer> {
  const { createServer } = await import('node:http');
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/embeddings' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        calls++;
        // Deterministic vector: hash the prompt to a seed, fill the vector with a pattern.
        const parsed = JSON.parse(body) as { prompt: string };
        const seed = parsed.prompt.length;
        const embedding = new Array<number>(dim).fill(0).map((_, i) => (seed + i) / (dim * 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embedding }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad addr');
  return {
    port: addr.port,
    callCount: () => calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('robin reindex', () => {
  let tmpRoot: string;
  let dataDir: string;
  let stub: StubServer;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'robin-reindex-test-'));
    dataDir = join(tmpRoot, 'user-data');
    mkdirSync(join(dataDir, 'config'), { recursive: true });
    mkdirSync(join(dataDir, 'state', 'db'), { recursive: true });
    process.env.ROBIN_USER_DATA_DIR = dataDir;
    stub = await startStubOllama(4096);
    writeFileSync(
      join(dataDir, 'config', 'models.yaml'),
      `roles:\n  embed:\n    provider: ollama\n    baseUrl: http://127.0.0.1:${stub.port}\n    model: stub-embed\n`,
    );
    const db = openDb(dbFilePath(dataDir));
    applyMigrations(db, allMigrations);
    closeDb(db);
  });

  afterEach(async () => {
    delete process.env.ROBIN_USER_DATA_DIR;
    await stub.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('embeds rows in events_content that have NULL embedding', async () => {
    const db = openDb(dbFilePath(dataDir));
    db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?), (?, ?), (?, ?)`).run(
      '2026-05-19T00:00:00Z',
      'one',
      '2026-05-19T00:01:00Z',
      'two-text',
      '2026-05-19T00:02:00Z',
      'three-here',
    );
    closeDb(db);

    const report = await runReindex();
    assert.equal(report.total_eligible, 3);
    assert.equal(report.embedded, 3);
    assert.equal(report.failed, 0);
    assert.equal(stub.callCount(), 3);

    const db2 = openDb(dbFilePath(dataDir));
    const filled = db2
      .prepare(`SELECT COUNT(*) AS n FROM events_content WHERE embedding IS NOT NULL`)
      .get() as { n: number };
    closeDb(db2);
    assert.equal(filled.n, 3);
  });

  it('skips rows that already have an embedding', async () => {
    const db = openDb(dbFilePath(dataDir));
    const dummy = Buffer.alloc(4096 * 4); // zero-filled float32[4096]
    db.prepare(`INSERT INTO events_content (ts, body, embedding) VALUES (?, ?, ?)`).run(
      '2026-05-19T00:00:00Z',
      'already-done',
      dummy,
    );
    db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`).run(
      '2026-05-19T00:01:00Z',
      'needs-it',
    );
    closeDb(db);

    const report = await runReindex();
    assert.equal(report.total_eligible, 1);
    assert.equal(report.embedded, 1);
    assert.equal(stub.callCount(), 1);
  });

  it('--limit caps the work', async () => {
    const db = openDb(dbFilePath(dataDir));
    const ins = db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`);
    for (let i = 0; i < 5; i++) ins.run('2026-05-19T00:00:00Z', `row-${i}`);
    closeDb(db);

    const report = await runReindex({ limit: 2 });
    assert.equal(report.total_eligible, 2);
    assert.equal(report.embedded, 2);
    assert.equal(stub.callCount(), 2);
  });

  it('reports missing embed role cleanly', async () => {
    writeFileSync(join(dataDir, 'config', 'models.yaml'), `roles: {}\n`);
    const report = await runReindex();
    assert.equal(report.embedded, 0);
    assert.match(report.errors[0] ?? '', /no embed role configured/);
  });
});
