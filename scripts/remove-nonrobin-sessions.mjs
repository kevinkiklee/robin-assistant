// Remove sessions (and their derived entities/relations) captured from folders
// OTHER than the robin workspace. These were captured before the cwd-scoping
// guard existed (the 5/21 bulk import). Robin memory should only hold robin work.
// Run: ROBIN_USER_DATA_DIR=./user-data node --import tsx scripts/remove-nonrobin-sessions.mjs
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, closeDb } from '../system/brain/memory/db.ts';
import { dbFilePath, resolveUserDataDir } from '../system/lib/paths.ts';

const projDir = join(homedir(), '.claude', 'projects');
const sidToFolder = new Map();
for (const folder of readdirSync(projDir)) {
  let files;
  try { files = readdirSync(join(projDir, folder)); } catch { continue; }
  for (const f of files) if (f.endsWith('.jsonl')) sidToFolder.set(f.replace('.jsonl', ''), folder);
}
const isRobin = (folder) => folder && /^-Users-iser-workspace-robin/.test(folder);

const db = openDb(dbFilePath(resolveUserDataDir()));

const sessions = db
  .prepare(`SELECT id, content_ref, json_extract(payload,'$.sessionId') sid FROM events WHERE kind='session.captured'`)
  .all();

// Non-robin session event IDs (transcript exists and its folder is not robin)
const S = new Set();
const sessionContentRefs = [];
for (const s of sessions) {
  const folder = sidToFolder.get(s.sid);
  if (folder && !isRobin(folder)) {
    S.add(s.id);
    if (s.content_ref) sessionContentRefs.push(s.content_ref);
  }
}

const before = {
  entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
  relations: db.prepare('SELECT COUNT(*) c FROM relations').get().c,
  sessions: sessions.length,
  extracted: db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='biographer.extracted'`).get().c,
};

db.exec('BEGIN');

// 1. Classify entities by relation provenance. An entity is "protected" if it has
//    any relation NOT from a non-robin session (i.e. connected via a kept session
//    or a NULL-source relation). Entities whose only relations are non-robin get
//    deleted along with those relations.
const protectedEntities = new Set();
const nonRobinEntities = new Set();
for (const r of db.prepare('SELECT subject_id, object_id, source_event_id FROM relations').all()) {
  const target = r.source_event_id != null && S.has(r.source_event_id) ? nonRobinEntities : protectedEntities;
  target.add(r.subject_id);
  target.add(r.object_id);
}

// 2. Delete non-robin relations
const delRel = db.prepare('DELETE FROM relations WHERE source_event_id = ?');
let relDeleted = 0;
for (const id of S) relDeleted += delRel.run(id).changes;

// 3. Delete entities that had ONLY non-robin relations (now orphaned, non-robin-only)
const delEnt = db.prepare('DELETE FROM entities WHERE id = ?');
let entDeleted = 0;
for (const eid of nonRobinEntities) {
  if (!protectedEntities.has(eid)) entDeleted += delEnt.run(eid).changes;
}

// 4. Delete biographer.extracted markers for these sessions (+ their content)
const extractedRows = db
  .prepare(`SELECT id, content_ref FROM events WHERE kind='biographer.extracted' AND json_extract(payload,'$.source_event_id') IN (${[...S].join(',') || 'NULL'})`)
  .all();
const delEvent = db.prepare('DELETE FROM events WHERE id = ?');
const delContent = db.prepare('DELETE FROM events_content WHERE id = ?');
const delVec = db.prepare('DELETE FROM events_vec WHERE rowid = ?');
let extractedDeleted = 0;
for (const e of extractedRows) {
  delEvent.run(e.id);
  if (e.content_ref) { delContent.run(e.content_ref); try { delVec.run(e.content_ref); } catch {} }
  extractedDeleted++;
}

// 5. Delete the session.captured events themselves (+ content + embeddings)
let sessDeleted = 0;
for (const id of S) sessDeleted += delEvent.run(id).changes;
for (const cref of sessionContentRefs) {
  delContent.run(cref);
  try { delVec.run(cref); } catch {}
}

// 6. Clean any biographer_progress rows for these sessions
db.exec(`DELETE FROM biographer_progress WHERE source_event_id IN (${[...S].join(',') || 'NULL'})`);

db.exec('COMMIT');

const after = {
  entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
  relations: db.prepare('SELECT COUNT(*) c FROM relations').get().c,
  sessions: db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='session.captured'`).get().c,
  extracted: db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='biographer.extracted'`).get().c,
};

console.log(JSON.stringify({
  non_robin_sessions_removed: S.size,
  relations_deleted: relDeleted,
  entities_deleted: entDeleted,
  extracted_markers_deleted: extractedDeleted,
  sessions: `${before.sessions} -> ${after.sessions}`,
  entities: `${before.entities} -> ${after.entities}`,
  relations: `${before.relations} -> ${after.relations}`,
}, null, 2));

closeDb(db);
