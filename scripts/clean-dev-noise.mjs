// Delete dev-internal noise using the live biographer filter (name+type), but
// SPARE library/tool types — they hold legit .js/tech frameworks (Three.js,
// Next.js, Node.js) the file-ref regex over-matches. Relations cascade.
import Database from 'better-sqlite3';
import { isLowQualityEntity } from '../system/brain/cognition/biographer.ts';

const SPARE = new Set(['library', 'tool']);
const db = new Database(process.env.ROBIN_DB);
const all = db.prepare('SELECT id, type, canonical_name FROM entities').all();
const del = all.filter((e) => isLowQualityEntity(e.canonical_name, e.type) && !SPARE.has(e.type));
const apply = process.argv.includes('--apply');
const byType = {};
for (const e of del) byType[e.type] = (byType[e.type] || 0) + 1;
console.log(
  `entities=${all.length} | to-delete=${del.length} (sparing ${[...SPARE].join('/')}) | ${apply ? 'APPLY' : 'DRY'}`,
);
console.log('by type:', JSON.stringify(byType));
const things = del.filter((e) => e.type === 'thing').map((e) => e.canonical_name);
console.log(`\nthing sample (40 of ${things.length}):`);
for (const n of things.slice(0, 40)) console.log(`  - ${n}`);
if (apply) {
  const stmt = db.prepare('DELETE FROM entities WHERE id = ?');
  db.transaction((rows) => {
    for (const e of rows) stmt.run(e.id);
  })(del);
  console.log(
    `\nDELETED ${del.length} | now entities=${db.prepare('SELECT count(*) c FROM entities').get().c} relations=${db.prepare('SELECT count(*) c FROM relations').get().c}`,
  );
}
