import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import type { IntegrationContext } from '../../_runtime/types.ts';
import { integration } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cc-cap-'));
  const dbPath = join(dir, 'test.sqlite');
  const db = openDb(dbPath);
  applyMigrations(db, allMigrations);
  return { db, dir, dbPath };
}

function fakeCtx(opts: {
  db: ReturnType<typeof freshDb>['db'];
  now?: Date;
  state?: Map<string, string>;
}): IntegrationContext {
  const state = opts.state ?? new Map();
  return {
    db: opts.db,
    llm: null,
    state: {
      get: (k) => state.get(k) ?? null,
      set: (k, v) => state.set(k, v),
      delete: (k) => state.delete(k),
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    fetch: globalThis.fetch,
    now: () => opts.now ?? new Date(),
    ingest: async () => ({ eventId: 0, contentId: undefined, embedded: false }),
    checkOutbound: () => ({ ok: true }),
  };
}

describe('claude_code integration tick', () => {
  let tmpRoot: string;
  let db: ReturnType<typeof freshDb>['db'];
  let dbDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    const fresh = freshDb();
    db = fresh.db;
    dbDir = fresh.dir;
    tmpRoot = mkdtempSync(join(tmpdir(), 'robin-cc-home-'));
    mkdirSync(join(tmpRoot, '.claude', 'projects', 'test-project'), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
  });

  it('skips sessions still being modified', async () => {
    const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'active.jsonl');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello world this is a substantive question' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'a substantive reply with several words' },
        }) +
        '\n',
    );
    // mtime is "now" - session is fresh, should skip
    const result = await integration.tick!(fakeCtx({ db }));
    assert.equal(result.status, 'ok');
    assert.equal(result.ingested, 0);
    const events = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
      .get() as { c: number };
    assert.equal(events.c, 0);
  });

  it('captures sessions idle for >10 minutes', async () => {
    const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'idle.jsonl');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'a substantive question about something' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'a substantive answer with content' },
        }) +
        '\n',
    );
    // Backdate mtime by 15 minutes
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);

    const result = await integration.tick!(fakeCtx({ db }));
    assert.equal(result.status, 'ok');
    assert.equal(result.ingested, 1);
    const events = db
      .prepare(`SELECT kind, source FROM events WHERE kind = 'session.captured'`)
      .all() as Array<{ kind: string; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'capture');
  });

  it('does not re-capture an already-processed file at the same mtime', async () => {
    const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'once.jsonl');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'first question with enough content to pass skip rules' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'first answer with substantive content here' },
        }) +
        '\n',
    );
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);

    const state = new Map<string, string>();
    const first = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(first.ingested, 1);
    const second = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(second.ingested, 0); // skipped via state
    const events = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
      .get() as { c: number };
    assert.equal(events.c, 1);
  });

  it('health check passes when projects dir exists', async () => {
    const r = await integration.health!(fakeCtx({ db }));
    assert.equal(r.ok, true);
  });
});
