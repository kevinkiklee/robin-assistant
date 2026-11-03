import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { quantizeToInt8Json } from '../../brain/memory/vec-quantize.ts';
import { dbFilePath } from '../paths.ts';
import {
  type ArgvRunner,
  MAC_ONLY_EVENT_SOURCES,
  MOVE_EXCLUDES,
  restoreMacOnlyRows,
  scrubMacOnlyRows,
  shq,
  snapshotDb,
  sshRemote,
} from './transfer.ts';

function fakeRunner(code = 0) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: ArgvRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code, stdout: '', stderr: code === 0 ? '' : 'boom' };
  };
  return { calls, run };
}

/** A user-data dir whose DB is built through the real migrations. */
function fixture(): { userData: string; dbPath: string; db: RobinDb } {
  const userData = mkdtempSync(join(tmpdir(), 'robin-transfer-'));
  const dbPath = dbFilePath(userData);
  mkdirSync(join(userData, 'state', 'db'), { recursive: true });
  const db = openDb(dbPath);
  applyMigrations(db, allMigrations);
  return { userData, dbPath, db };
}

/** Mark a content row embedded the way the embedder does: sentinel + int8 vec row. */
function embed(db: RobinDb, contentId: number): void {
  db.prepare(`UPDATE events_content SET embedding = x'01' WHERE id = ?`).run(contentId);
  db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`).run(
    BigInt(contentId),
    quantizeToInt8Json(new Array(3072).fill(0.05)),
  );
}

/** 3 Mac-only events + 2 others, every one with embedded content. */
function seed(db: RobinDb): { macContent: number[]; otherContent: number[] } {
  const macContent: number[] = [];
  const otherContent: number[] = [];
  const mac = ['marzipan', 'quokka', 'zeppelin'];
  for (const [i, word] of mac.entries()) {
    const r = ingest(db, null, {
      kind: 'knowledge.archive',
      source: 'imessage',
      content: `archived thread about ${word}`,
      payload: { thread: `t-${i}` },
    });
    embed(db, r.contentId as number);
    macContent.push(r.contentId as number);
  }
  for (const [i, word] of ['sourdough', 'cadence'].entries()) {
    const r = ingest(db, null, {
      kind: 'knowledge.doc',
      source: 'docs',
      content: `note about ${word}`,
      payload: { path: `content/knowledge/n-${i}.md` },
    });
    embed(db, r.contentId as number);
    otherContent.push(r.contentId as number);
  }
  return { macContent, otherContent };
}

function count(db: RobinDb, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

const ftsHits = (db: RobinDb, word: string) =>
  count(db, `SELECT COUNT(*) AS c FROM events_content_fts WHERE events_content_fts MATCH ?`, word);

test('excludes are exact', () => {
  assert.deepEqual(MOVE_EXCLUDES, [
    'backups/',
    '**/dem_cache/',
    '**/.venv/',
    'state/chrome-profile/',
    'state/robin.db',
    'state/db/',
    'state/runtime/cloud-role.json',
    'state/runtime/*.lock',
    '**/*.pid',
    'observability/logs/',
    'agent-runs/',
    'content/sources/imessage/',
    'content/sources/corpus/',
    'content/knowledge/imessage-contacts.md',
    'content/knowledge/biography-from-corpus-*.md',
  ]);
  assert.deepEqual(MAC_ONLY_EVENT_SOURCES, ['imessage']);
});

test('push argv: archive + partial, one --exclude per entry, trailing-slash dirs, never --delete', async () => {
  const { calls, run } = fakeRunner();
  const remote = sshRemote('example-vm', run);
  assert.equal(remote.host, 'example-vm');
  await remote.push('/data/user-data', 'robin-assistant-v3/user-data', MOVE_EXCLUDES);
  assert.equal(calls.length, 1);
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'rsync');
  assert.ok(args.includes('-a'));
  assert.ok(args.includes('--partial'));
  assert.ok(args.includes('--info=progress2'));
  const e = args.indexOf('-e');
  assert.ok(e >= 0);
  assert.equal(args[e + 1], 'ssh -o BatchMode=yes');
  for (const p of MOVE_EXCLUDES) assert.ok(args.includes(`--exclude=${p}`), p);
  assert.equal(args.filter((a) => a.startsWith('--exclude')).length, MOVE_EXCLUDES.length);
  assert.ok(!args.some((a) => a.startsWith('--del')), 'never --delete');
  assert.deepEqual(args.slice(-2), [
    '/data/user-data/',
    'example-vm:robin-assistant-v3/user-data/',
  ]);
});

test('pull argv mirrors push (remote source first), custom rsync binary, files have no slash', async () => {
  const { calls, run } = fakeRunner();
  const remote = sshRemote('example-vm', run, { rsync: '/opt/homebrew/bin/rsync' });
  await remote.pull('robin-assistant-v3/user-data/', '/data/user-data/', ['agent-runs/']);
  await remote.pushFile('/tmp/snap.sqlite', 'robin-assistant-v3/snap.sqlite');
  await remote.pullFile('robin-assistant-v3/snap.sqlite', '/tmp/back.sqlite');
  assert.equal(calls[0].cmd, '/opt/homebrew/bin/rsync');
  assert.deepEqual(calls[0].args.slice(-2), [
    'example-vm:robin-assistant-v3/user-data/',
    '/data/user-data/',
  ]);
  assert.ok(calls[0].args.includes('--exclude=agent-runs/'));
  assert.deepEqual(calls[1].args.slice(-2), [
    '/tmp/snap.sqlite',
    'example-vm:robin-assistant-v3/snap.sqlite',
  ]);
  assert.deepEqual(calls[2].args.slice(-2), [
    'example-vm:robin-assistant-v3/snap.sqlite',
    '/tmp/back.sqlite',
  ]);
  for (const c of calls) assert.ok(!c.args.some((a) => a.startsWith('--del')));
});

test('a host that could parse as an option or change the target is refused', () => {
  for (const h of ['-oProxyCommand=x', 'a b', 'vm:path', '']) {
    assert.throws(() => sshRemote(h, fakeRunner().run), /invalid ssh host/, h);
  }
  assert.doesNotThrow(() => sshRemote('user@example-vm.local', fakeRunner().run));
});

test('a failed rsync rejects with its exit code', async () => {
  const { run } = fakeRunner(23);
  await assert.rejects(sshRemote('example-vm', run).push('/a', 'b', []), /exit 23.*boom/s);
});

test('exec quotes each remote arg (space and single quote survive the remote shell)', async () => {
  const { calls, run } = fakeRunner();
  const r = await sshRemote('example-vm', run).exec(['printf', '%s\\n', "it's a test", 'x']);
  assert.equal(r.code, 0);
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'ssh');
  assert.deepEqual(args.slice(0, 4), ['-o', 'BatchMode=yes', 'example-vm', '--']);
  const remoteArgs = args.slice(4);
  assert.deepEqual(remoteArgs, [shq('printf'), shq('%s\\n'), shq("it's a test"), shq('x')]);
  // ssh joins argv with spaces and hands it to the remote shell; a POSIX sh must
  // reconstruct the original argv exactly.
  const out = execFileSync('sh', ['-c', remoteArgs.join(' ')], { encoding: 'utf8' });
  assert.equal(out, "it's a test\nx\n");
  assert.equal(shq(''), "''");
  assert.equal(shq("a'b"), `'a'\\''b'`);
});

test('snapshotDb writes a readable copy with the same rows while the source stays open', () => {
  const { userData, db } = fixture();
  seed(db);
  const out = join(userData, 'snap.sqlite');
  snapshotDb(userData, out);
  // Source connection still open and usable.
  ingest(db, null, { kind: 'knowledge.doc', source: 'docs', content: 'after snapshot' });
  const src = count(db, `SELECT COUNT(*) AS c FROM events`);
  closeDb(db);
  const snap = openDb(out);
  try {
    assert.equal(count(snap, `SELECT COUNT(*) AS c FROM events`), src - 1);
    assert.equal(count(snap, `SELECT COUNT(*) AS c FROM events_vec`), 5);
    assert.equal(ftsHits(snap, 'quokka'), 1);
  } finally {
    closeDb(snap);
  }
});

test('scrub removes Mac-only rows and their dependents', () => {
  const { userData, dbPath, db } = fixture();
  const { macContent, otherContent } = seed(db);
  closeDb(db);
  const snap = join(userData, 'snap.sqlite');
  snapshotDb(userData, snap);

  const r = scrubMacOnlyRows(snap, { liveDbPath: dbPath });
  assert.equal(r.removed, 3);

  const s = openDb(snap);
  try {
    assert.equal(count(s, `SELECT COUNT(*) AS c FROM events WHERE source = 'imessage'`), 0);
    assert.equal(count(s, `SELECT COUNT(*) AS c FROM events`), 2);
    for (const id of macContent) {
      assert.equal(count(s, `SELECT COUNT(*) AS c FROM events_content WHERE id = ?`, id), 0);
      assert.equal(count(s, `SELECT COUNT(*) AS c FROM events_vec WHERE rowid = ?`, BigInt(id)), 0);
    }
    for (const w of ['marzipan', 'quokka', 'zeppelin', 'archived'])
      assert.equal(ftsHits(s, w), 0, w);
    for (const id of otherContent) {
      assert.equal(count(s, `SELECT COUNT(*) AS c FROM events_content WHERE id = ?`, id), 1);
      assert.equal(count(s, `SELECT COUNT(*) AS c FROM events_vec WHERE rowid = ?`, BigInt(id)), 1);
    }
    assert.equal(ftsHits(s, 'sourdough'), 1);
    assert.equal(ftsHits(s, 'cadence'), 1);
    // vec.index_synced stays satisfied.
    assert.equal(
      count(s, `SELECT COUNT(*) AS c FROM events_content WHERE embedding IS NOT NULL`),
      count(s, `SELECT COUNT(*) AS c FROM events_vec`),
    );
    assert.equal(s.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    closeDb(s);
  }

  // The scrubbed text is gone from the file itself — no freed page or stale FTS
  // segment still carries it to the VM.
  const bytes = readFileSync(snap);
  for (const w of ['marzipan', 'quokka', 'zeppelin']) assert.ok(!bytes.includes(w), w);
  assert.ok(bytes.includes('sourdough'), 'control: surviving text is still in the file');
});

test('scrub refuses the live DB, also through a symlink', () => {
  const { userData, dbPath, db } = fixture();
  seed(db);
  closeDb(db);
  assert.throws(() => scrubMacOnlyRows(dbPath, { liveDbPath: dbPath }), /live DB/);
  const link = join(userData, 'alias.sqlite');
  symlinkSync(dbPath, link);
  assert.throws(() => scrubMacOnlyRows(link, { liveDbPath: dbPath }), /live DB/);
  const live = new Database(dbPath, { readonly: true });
  try {
    assert.equal(count(live, `SELECT COUNT(*) AS c FROM events WHERE source = 'imessage'`), 3);
  } finally {
    live.close();
  }
});

test('restore brings them back', () => {
  const { userData, dbPath, db } = fixture();
  seed(db);
  closeDb(db);
  const snap = join(userData, 'snap.sqlite');
  snapshotDb(userData, snap);
  scrubMacOnlyRows(snap, { liveDbPath: dbPath });

  const r = restoreMacOnlyRows(dbPath, snap);
  assert.equal(r.restored, 3);
  const s = openDb(snap);
  try {
    assert.equal(count(s, `SELECT COUNT(*) AS c FROM events WHERE source = 'imessage'`), 3);
    assert.equal(
      count(
        s,
        `SELECT COUNT(*) AS c FROM events e JOIN events_content c ON c.id = e.content_ref
          WHERE e.source = 'imessage' AND c.embedding IS NULL`,
      ),
      3,
      'content back, embeddings left for the embedder',
    );
    assert.equal(ftsHits(s, 'quokka'), 1);
    assert.equal(ftsHits(s, 'zeppelin'), 1);
    assert.equal(ftsHits(s, 'sourdough'), 1);
  } finally {
    closeDb(s);
  }

  const again = restoreMacOnlyRows(dbPath, snap);
  assert.equal(again.restored, 0);
  const s2 = openDb(snap);
  try {
    assert.equal(count(s2, `SELECT COUNT(*) AS c FROM events WHERE source = 'imessage'`), 3);
    assert.equal(count(s2, `SELECT COUNT(*) AS c FROM events_content`), 5);
    assert.equal(ftsHits(s2, 'quokka'), 1);
    assert.equal(s2.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    closeDb(s2);
  }
});

test('restore never overwrites a row the VM created at a reused id', () => {
  const { userData, dbPath, db } = fixture();
  seed(db);
  // The newest event + content are Mac-only, so after the scrub SQLite hands
  // their ids to the next rows the VM writes.
  const tail = ingest(db, null, {
    kind: 'knowledge.archive',
    source: 'imessage',
    content: 'archived thread about origami',
    payload: { thread: 't-tail' },
  });
  closeDb(db);
  const vmDb = join(userData, 'vm.sqlite');
  snapshotDb(userData, vmDb);
  scrubMacOnlyRows(vmDb, { liveDbPath: dbPath });
  const vm = openDb(vmDb);
  const fresh = ingest(vm, null, {
    kind: 'knowledge.doc',
    source: 'docs',
    content: 'vm wrote this',
  });
  closeDb(vm);
  assert.equal(fresh.eventId, tail.eventId, 'fixture: the VM reused the scrubbed id');

  const r = restoreMacOnlyRows(dbPath, vmDb);
  assert.equal(r.restored, 4);
  const s = openDb(vmDb);
  try {
    assert.equal(count(s, `SELECT COUNT(*) AS c FROM events WHERE source = 'imessage'`), 4);
    assert.equal(ftsHits(s, 'origami'), 1);
    assert.equal(ftsHits(s, 'wrote'), 1, "the VM's row is intact");
    const vmRow = s.prepare(`SELECT source FROM events WHERE id = ?`).get(fresh.eventId) as {
      source: string;
    };
    assert.equal(vmRow.source, 'docs');
  } finally {
    closeDb(s);
  }
  assert.equal(restoreMacOnlyRows(dbPath, vmDb).restored, 0, 'a second restore is a no-op');
  assert.ok(existsSync(vmDb));
});
