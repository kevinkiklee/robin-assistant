import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { slugifyCwdPath } from '../../../brain/cognition/capture.ts';
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

  it('skips transcripts under Robin’s own user-data project dir (internal SDK cognition)', async () => {
    // Robin's non-interactive Agent-SDK cognition calls write transcripts under
    // user-data/. The scanner must not re-capture them (self-amplifying loop),
    // even though the transcript itself looks like a substantive session.
    const userData = join(tmpRoot, 'robin', 'user-data');
    const prev = process.env.ROBIN_USER_DATA_DIR;
    process.env.ROBIN_USER_DATA_DIR = userData;
    try {
      const internalDir = join(tmpRoot, '.claude', 'projects', slugifyCwdPath(userData));
      mkdirSync(internalDir, { recursive: true });
      const sessionFile = join(internalDir, 'cognition.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: 'a substantive question about Sam, his cameras, and travel plans',
          },
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: 'a substantive answer naming Sam, his Acme X1, and a trip to Lisbon',
            },
          }) +
          '\n',
      );
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);

      const result = await integration.tick!(fakeCtx({ db }));
      assert.equal(result.ingested, 0, 'internal user-data transcript must not be captured');
      const events = db
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
        .get() as { c: number };
      assert.equal(events.c, 0);
    } finally {
      if (prev !== undefined) process.env.ROBIN_USER_DATA_DIR = prev;
      else delete process.env.ROBIN_USER_DATA_DIR;
    }
  });

  it('still captures real interactive sessions outside user-data', async () => {
    // Guard: the internal-dir skip must not suppress the operator's real sessions, which
    // run from the repo root (a sibling slug), here represented by test-project.
    const userData = join(tmpRoot, 'robin', 'user-data');
    const prev = process.env.ROBIN_USER_DATA_DIR;
    process.env.ROBIN_USER_DATA_DIR = userData;
    try {
      const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'real.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'a substantive question about something real' },
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: 'a substantive answer with real content' },
          }) +
          '\n',
      );
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);

      const result = await integration.tick!(fakeCtx({ db }));
      assert.equal(result.ingested, 1, 'real interactive session must still be captured');
    } finally {
      if (prev !== undefined) process.env.ROBIN_USER_DATA_DIR = prev;
      else delete process.env.ROBIN_USER_DATA_DIR;
    }
  });

  it('incognito: consumes settled sessions without capturing, so they never capture later', async () => {
    const userData = join(tmpRoot, 'robin', 'user-data');
    mkdirSync(join(userData, 'config'), { recursive: true });
    const policiesPath = join(userData, 'config', 'policies.yaml');
    const prev = process.env.ROBIN_USER_DATA_DIR;
    process.env.ROBIN_USER_DATA_DIR = userData;
    try {
      const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'private.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'a substantive private question during incognito' },
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: 'a substantive private answer during incognito',
            },
          }) +
          '\n',
      );
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);

      const state = new Map<string, string>();
      writeFileSync(policiesPath, 'capture:\n  enabled: false\n');
      const during = await integration.tick!(fakeCtx({ db, state }));
      assert.equal(during.ingested, 0, 'nothing captured while incognito');

      writeFileSync(policiesPath, 'capture:\n  enabled: true\n');
      const after = await integration.tick!(fakeCtx({ db, state }));
      assert.equal(after.ingested, 0, 'an incognito-era session is not captured once it ends');
      const events = db
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
        .get() as { c: number };
      assert.equal(events.c, 0);
    } finally {
      if (prev !== undefined) process.env.ROBIN_USER_DATA_DIR = prev;
      else delete process.env.ROBIN_USER_DATA_DIR;
    }
  });

  it('incognito with a past expires_at has lapsed — capture resumes', async () => {
    const userData = join(tmpRoot, 'robin', 'user-data');
    mkdirSync(join(userData, 'config'), { recursive: true });
    writeFileSync(
      join(userData, 'config', 'policies.yaml'),
      `capture:\n  enabled: false\n  expires_at: '${new Date(Date.now() - 60_000).toISOString()}'\n`,
    );
    const prev = process.env.ROBIN_USER_DATA_DIR;
    process.env.ROBIN_USER_DATA_DIR = userData;
    try {
      const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'later.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'a substantive question after incognito ended' },
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: 'a substantive answer after incognito ended' },
          }) +
          '\n',
      );
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);
      const result = await integration.tick!(fakeCtx({ db }));
      assert.equal(result.ingested, 1);
    } finally {
      if (prev !== undefined) process.env.ROBIN_USER_DATA_DIR = prev;
      else delete process.env.ROBIN_USER_DATA_DIR;
    }
  });

  it('baselines a historical transcript (>48h idle, no cursor) instead of re-ingesting it', async () => {
    // Regression for the 2026-06-13 re-burst: a purge wiped the `session:*` dedup state, so
    // every settled transcript ever written looked new and ~3,674 were re-ingested in one
    // tick. A file untouched for >48h with no cursor must be baselined, not captured.
    const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'historical.jsonl');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'an old substantive question from days ago' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'an old substantive answer with content' },
        }) +
        '\n',
    );
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(sessionFile, threeDaysAgo, threeDaysAgo);

    const state = new Map<string, string>();
    const result = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(result.ingested, 0, 'historical transcript must not be captured on cold cursor');
    const events = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
      .get() as { c: number };
    assert.equal(events.c, 0);
    // It must be baselined so it is not re-examined every tick.
    assert.equal(state.has('session:test-project:historical'), true, 'cursor must be set');
  });

  it('still captures a resumed historical session once its file is re-touched', async () => {
    // The 48h baseline must not suppress a session the user actually resumes: resuming
    // re-touches the .jsonl, dropping idleMs below the horizon → normal capture.
    const sessionFile = join(tmpRoot, '.claude', 'projects', 'test-project', 'resumed.jsonl');
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'a substantive question in a resumed session' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'a substantive answer in the resumed session' },
        }) +
        '\n',
    );
    // Recently active (15 min idle), even though it's an old session id.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);

    const result = await integration.tick!(fakeCtx({ db }));
    assert.equal(result.ingested, 1, 'a recently-touched session must capture normally');
  });

  it('caps actual captures per tick and defers the remainder without advancing their cursor', async () => {
    // A daemon restart drained a ~115-session backlog in one tick, flooding the biographer
    // and the memory graph. The scanner must cap actual captures per tick so a backlog
    // drains smoothly over several 5-min ticks. Seed more than the cap of settled,
    // capturable sessions (15 min idle — past the settle horizon but not past the 48h
    // baseline horizon) and assert exactly the cap is captured this tick.
    const projectPath = join(tmpRoot, '.claude', 'projects', 'test-project');
    const total = 25; // > MAX_CAPTURES_PER_TICK (20)
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    for (let i = 0; i < total; i++) {
      const sessionFile = join(projectPath, `backlog-${String(i).padStart(2, '0')}.jsonl`);
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: `a substantive question number ${i} about something` },
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: `a substantive answer number ${i} with content`,
            },
          }) +
          '\n',
      );
      utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);
    }

    const state = new Map<string, string>();
    const result = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(result.status, 'ok');
    assert.equal(result.ingested, 20, 'exactly MAX_CAPTURES_PER_TICK captured this tick');
    const events = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
      .get() as { c: number };
    assert.equal(events.c, 20);

    // The deferred remainder must NOT have its cursor advanced, so it is retried next tick.
    let cursored = 0;
    for (let i = 0; i < total; i++) {
      if (state.has(`session:test-project:backlog-${String(i).padStart(2, '0')}`)) cursored++;
    }
    assert.equal(cursored, 20, 'only captured sessions get a cursor; deferred ones are untouched');
  });

  it('captures the previously-deferred sessions on the next tick (backlog drains over ticks)', async () => {
    const projectPath = join(tmpRoot, '.claude', 'projects', 'test-project');
    const total = 25; // 20 captured tick 1, remaining 5 captured tick 2
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    for (let i = 0; i < total; i++) {
      const sessionFile = join(projectPath, `drain-${String(i).padStart(2, '0')}.jsonl`);
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: `a substantive question number ${i} about draining` },
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: `a substantive answer number ${i} draining` },
          }) +
          '\n',
      );
      utimesSync(sessionFile, fifteenMinAgo, fifteenMinAgo);
    }

    const state = new Map<string, string>();
    const first = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(first.ingested, 20, 'first tick captures the cap');
    const second = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(second.ingested, 5, 'second tick captures the deferred remainder');

    const events = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured'`)
      .get() as { c: number };
    assert.equal(events.c, 25, 'all backlog sessions captured across two ticks, none lost');
  });

  function writeSession(path: string, n: number, mtime: Date): void {
    writeFileSync(
      path,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `a substantive question number ${n} about dirs` },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: `a substantive answer number ${n} about dirs` },
        }) +
        '\n',
    );
    utimesSync(path, mtime, mtime);
  }

  it('skips an unchanged project dir on the next tick, rescans it once the dir changes', async () => {
    const projectPath = join(tmpRoot, '.claude', 'projects', 'test-project');
    const old = new Date(Date.now() - 15 * 60 * 1000);
    writeSession(join(projectPath, 'a.jsonl'), 1, old);
    const dirTime = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(projectPath, dirTime, dirTime);

    const state = new Map<string, string>();
    const first = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(first.ingested, 1);
    assert.match(first.message ?? '', /dirsUnchanged=0/);
    assert.ok(state.has('dir:test-project'), 'dir cursor persisted in integration state');

    // An in-place append doesn't move the dir mtime: the dir is skipped (no stat).
    writeSession(join(projectPath, 'a.jsonl'), 2, new Date(Date.now() - 12 * 60 * 1000));
    utimesSync(projectPath, dirTime, dirTime);
    const second = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(second.ingested, 0);
    assert.match(second.message ?? '', /dirsUnchanged=1/);

    // A new session file changes the dir mtime → rescanned, both captured.
    writeSession(join(projectPath, 'b.jsonl'), 3, old);
    const third = await integration.tick!(fakeCtx({ db, state }));
    assert.match(third.message ?? '', /dirsUnchanged=0/);
    assert.equal(third.ingested, 2, 'the appended session and the new one are both captured');
  });

  it('rescans an unchanged dir after the full-rescan window (catches in-place appends)', async () => {
    const projectPath = join(tmpRoot, '.claude', 'projects', 'test-project');
    writeSession(join(projectPath, 'a.jsonl'), 1, new Date(Date.now() - 15 * 60 * 1000));
    const dirTime = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(projectPath, dirTime, dirTime);
    const state = new Map<string, string>();
    await integration.tick!(fakeCtx({ db, state }));

    writeSession(join(projectPath, 'a.jsonl'), 2, new Date(Date.now() - 12 * 60 * 1000));
    utimesSync(projectPath, dirTime, dirTime);
    const later = new Date(Date.now() + 61 * 60 * 1000);
    const r = await integration.tick!(fakeCtx({ db, state, now: later }));
    assert.match(r.message ?? '', /dirsUnchanged=0/);
    assert.equal(r.ingested, 1);
  });

  it('keeps rescanning a dir whose last scan left an in-flight session', async () => {
    const projectPath = join(tmpRoot, '.claude', 'projects', 'test-project');
    const live = join(projectPath, 'live.jsonl');
    writeSession(live, 1, new Date()); // in flight
    const dirTime = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(projectPath, dirTime, dirTime);
    const state = new Map<string, string>();
    const first = await integration.tick!(fakeCtx({ db, state }));
    assert.equal(first.ingested, 0);

    // 15 min later the session has settled; the dir mtime never moved.
    const later = new Date(Date.now() + 15 * 60 * 1000);
    const second = await integration.tick!(fakeCtx({ db, state, now: later }));
    assert.match(second.message ?? '', /dirsUnchanged=0/);
    assert.equal(second.ingested, 1, 'the settled session is captured, not stranded');
  });

  it('skips transcripts over the size limit with a logged reason and advances the cursor', async () => {
    const projectPath = join(tmpRoot, '.claude', 'projects', 'test-project');
    const big = join(projectPath, 'big.jsonl');
    const line = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
    })}\n`;
    writeFileSync(big, line.repeat(11));
    const old = new Date(Date.now() - 15 * 60 * 1000);
    utimesSync(big, old, old);

    const warns: unknown[] = [];
    const state = new Map<string, string>();
    const ctx = fakeCtx({ db, state });
    ctx.log.warn = (obj: unknown) => {
      warns.push(obj);
    };
    const r = await integration.tick!(ctx);
    assert.equal(r.ingested, 0);
    assert.equal(warns.length, 1);
    assert.equal((warns[0] as { sessionId: string }).sessionId, 'big');
    assert.ok(state.has('session:test-project:big'), 'cursor advanced');
    // Next tick (dir forced to rescan): cursor matches → no repeat warning.
    state.delete('dir:test-project');
    await integration.tick!(ctx);
    assert.equal(warns.length, 1, 'logged once per change, not every tick');
  });

  it('health check passes when projects dir exists', async () => {
    const r = await integration.health!(fakeCtx({ db }));
    assert.equal(r.ok, true);
  });
});
