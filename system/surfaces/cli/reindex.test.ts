import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, test } from 'node:test';
import { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { LLMProvider } from '../../brain/llm/types.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { EMBEDDED_SENTINEL, runReindex, runReindexCore } from './reindex.ts';

// The test mocks the Ollama embed server. We point ROBIN_USER_DATA_DIR at a temp dir
// and seed a models.yaml that uses Ollama against a localhost stub so the reindex pass
// runs against deterministic vectors instead of a real GPU model.

interface StubServer {
  close: () => Promise<void>;
  port: number;
  callCount: () => number;
}

async function startStubOllama(dim = 3072): Promise<StubServer> {
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
    stub = await startStubOllama(3072);
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

  it('embeds a body stored as a BLOB (Buffer) — the box-drawing-char regression', async () => {
    // Reproduces content_ids 13466/13467: bodies written with a Buffer binding land with
    // BLOB affinity despite the TEXT column, and read back as Node Buffers. Before the fix,
    // the Buffer reached Ollama as a JSON object and the embed call 400'd. The stub here
    // reads `parsed.prompt.length`, so a non-string prompt would crash → 500 → failed row.
    const db = openDb(dbFilePath(dataDir));
    const blobBody = Buffer.from('━'.repeat(2000), 'utf8');
    db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`).run(
      '2026-05-19T00:00:00Z',
      blobBody,
    );
    // Confirm the row really has BLOB affinity, mirroring the live DB.
    const stored = db
      .prepare(`SELECT typeof(body) AS t FROM events_content WHERE id = 1`)
      .get() as { t: string };
    assert.equal(stored.t, 'blob');
    closeDb(db);

    const report = await runReindex();
    assert.equal(report.total_eligible, 1);
    assert.equal(report.embedded, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.errors.length, 0);
    assert.equal(stub.callCount(), 1);

    const db2 = openDb(dbFilePath(dataDir));
    const filled = db2
      .prepare(`SELECT COUNT(*) AS n FROM events_content WHERE embedding IS NOT NULL`)
      .get() as { n: number };
    closeDb(db2);
    assert.equal(filled.n, 1);
  });

  it('skips rows that already have an embedding', async () => {
    const db = openDb(dbFilePath(dataDir));
    const dummy = Buffer.alloc(3072 * 4); // zero-filled float32[3072]
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

  it('--ids restricts embed to the named rows', async () => {
    const db = openDb(dbFilePath(dataDir));
    const ins = db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`);
    for (let i = 0; i < 5; i++) ins.run('2026-05-19T00:00:00Z', `row-${i}`);
    closeDb(db);

    const report = await runReindex({ ids: [2, 4] });
    assert.equal(report.total_eligible, 2);
    assert.equal(report.embedded, 2);
    assert.equal(stub.callCount(), 2);

    const db2 = openDb(dbFilePath(dataDir));
    const filledIds = db2
      .prepare(`SELECT id FROM events_content WHERE embedding IS NOT NULL ORDER BY id`)
      .all() as Array<{ id: number }>;
    closeDb(db2);
    assert.deepEqual(
      filledIds.map((r) => r.id),
      [2, 4],
    );
  });

  it('--ids without --force skips already-embedded rows in the set', async () => {
    const db = openDb(dbFilePath(dataDir));
    const dummy = Buffer.alloc(3072 * 4);
    db.prepare(`INSERT INTO events_content (ts, body, embedding) VALUES (?, ?, ?)`).run(
      '2026-05-19T00:00:00Z',
      'already-embedded',
      dummy,
    );
    db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`).run(
      '2026-05-19T00:01:00Z',
      'still-null',
    );
    closeDb(db);

    const report = await runReindex({ ids: [1, 2] });
    assert.equal(report.total_eligible, 1, 'id=1 is already embedded → excluded');
    assert.equal(report.embedded, 1);
    assert.equal(stub.callCount(), 1);
  });

  it('--ids with --force re-embeds even rows that already have an embedding', async () => {
    const db = openDb(dbFilePath(dataDir));
    const dummy = Buffer.alloc(3072 * 4);
    db.prepare(`INSERT INTO events_content (ts, body, embedding) VALUES (?, ?, ?)`).run(
      '2026-05-19T00:00:00Z',
      'already-embedded',
      dummy,
    );
    closeDb(db);

    const report = await runReindex({ ids: [1], force: true });
    assert.equal(report.total_eligible, 1);
    assert.equal(report.embedded, 1);
    assert.equal(stub.callCount(), 1);
  });
});

// --- Embed policy: noise kinds are never vectorized (Tier 1) ---

function freshPolicyDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-reindex-policy-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockEmbedLLM(): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('nope');
    },
    embed: async (text: string | string[]) => {
      const arr = Array.isArray(text) ? text : [text];
      return arr.map(() => new Array(3072).fill(0.1));
    },
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  return d;
}

function isEmbedded(db: ReturnType<typeof openDb>, contentId?: number): boolean {
  const r = db
    .prepare(`SELECT embedding IS NOT NULL AS e FROM events_content WHERE id = ?`)
    .get(contentId) as { e: number };
  return r.e === 1;
}

test('reindex embeds high-value kinds and skips denied noise kinds', async () => {
  const db = freshPolicyDb();
  const keep = ingest(db, null, {
    kind: 'knowledge.doc',
    source: 's',
    content: 'kevin photography note',
  });
  const denyTxn = ingest(db, null, {
    kind: 'lunch_money.transaction',
    source: 's',
    content: 'coffee $4',
  });
  const denyTick = ingest(db, null, {
    kind: 'integration.finance_quote.tick',
    source: 's',
    content: 'tick ok',
  });

  const report = await runReindexCore(db, mockEmbedLLM());

  assert.equal(report.embedded, 1, 'only the embeddable row should be embedded');
  assert.equal(isEmbedded(db, keep.contentId), true);
  assert.equal(isEmbedded(db, denyTxn.contentId), false);
  assert.equal(isEmbedded(db, denyTick.contentId), false);

  const vecCount = db.prepare(`SELECT count(*) AS n FROM events_vec`).get() as { n: number };
  assert.equal(vecCount.n, 1, 'vec index holds only the kept row');
  closeDb(db);
});

test('reindex --force re-embeds eligible rows but still skips denied kinds', async () => {
  const db = freshPolicyDb();
  ingest(db, null, { kind: 'belief.update', source: 's', content: 'kevin owns a Nikon Zf' });
  ingest(db, null, { kind: 'spotify_played', source: 's', content: 'played a song' });

  const report = await runReindexCore(db, mockEmbedLLM(), { force: true });
  assert.equal(report.embedded, 1);
  closeDb(db);
});

test('reindex still embeds orphan content rows (no event) — preserves prior behavior', async () => {
  const db = freshPolicyDb();
  db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`).run(
    '2026-05-19T00:00:00Z',
    'orphan content with no event row',
  );
  const report = await runReindexCore(db, mockEmbedLLM());
  assert.equal(report.embedded, 1);
  closeDb(db);
});

test('reindex stores a 1-byte sentinel in events_content.embedding, not the full vector', async () => {
  const db = freshPolicyDb();
  const e = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'note' });
  await runReindexCore(db, mockEmbedLLM());

  // The 3072-d float32 vector lives ONLY in events_vec; events_content.embedding is a
  // tiny sentinel that the embedder eligibility query NULL-checks. This is the dedup
  // that reclaims ~381 MB on the live DB.
  const row = db
    .prepare(`SELECT length(embedding) AS len FROM events_content WHERE id = ?`)
    .get(e.contentId) as { len: number };
  assert.equal(row.len, EMBEDDED_SENTINEL.length);
  assert.equal(EMBEDDED_SENTINEL.length, 1, 'sentinel must be a single byte');

  const vec = db
    .prepare(`SELECT count(*) AS n FROM events_vec WHERE rowid = ?`)
    .get(e.contentId) as {
    n: number;
  };
  assert.equal(vec.n, 1, 'full vector retained in events_vec');
  closeDb(db);
});
