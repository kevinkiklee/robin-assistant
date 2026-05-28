import type { Migration } from './types.ts';

// 2026-05-28: belief topic slugs fragmented across style variants — dot-namespaced
// (`medications.ramelteon`, `hobby.birding`), underscore, and mixed-case forms all
// coexisting with their kebab equivalents (observed: 232 dot-separated topics, 2087
// distinct belief-update topics total). normalizeTopic() now folds dots/underscores/
// whitespace/case/punctuation into one kebab form; this migration applies that same
// transform retroactively so existing heads and candidates converge.
//
// SQL mirrors normalizeTopic() exactly: lower → [._\s]→'-' → strip non-[a-z0-9-] →
// collapse '-' → trim '-'. Collisions are safe: belief.update heads with the same
// topic become a normal supersession chain (recall takes the latest by ts), and
// belief_candidates has no unique topic constraint.
//
// SQLite lacks regexp in core, so the normalization is expressed as nested REPLACE
// calls covering the punctuation actually seen in topic slugs (. _ whitespace / : ,
// ( ) etc.). Anything exotic is left as-is rather than risking a bad rewrite.
// SQL string literal with proper single-quote escaping ('' for ').
const lit = (ch: string): string => `'${ch.replace(/'/g, "''")}'`;

function normSql(col: string): string {
  // dots, underscores, spaces → '-'
  let e = `lower(${col})`;
  for (const ch of ['.', '_', ' ']) {
    e = `replace(${e}, ${lit(ch)}, '-')`;
  }
  // strip the punctuation observed in slugs
  for (const ch of ['/', ':', ',', '(', ')', "'", '"', '#', '!', '?']) {
    e = `replace(${e}, ${lit(ch)}, '')`;
  }
  // collapse doubles (two passes handles up to 4 in a row)
  e = `replace(${e}, '--', '-')`;
  e = `replace(${e}, '--', '-')`;
  return e;
}

export const migration018: Migration = {
  version: 18,
  name: 'normalize-topics',
  up: (db) => {
    // 1. belief_candidates.topic
    db.exec(
      `UPDATE belief_candidates SET topic = ${normSql('topic')} WHERE topic != ${normSql('topic')};`,
    );
    // trim a single leading/trailing hyphen if normalization produced one
    db.exec(
      `UPDATE belief_candidates SET topic = trim(topic, '-') WHERE topic LIKE '-%' OR topic LIKE '%-';`,
    );

    // 2. belief.update event payloads — rewrite the JSON topic field in place.
    const norm = normSql(`json_extract(payload, '$.topic')`);
    db.exec(`
      UPDATE events
         SET payload = json_set(payload, '$.topic', trim(${norm}, '-'))
       WHERE kind = 'belief.update'
         AND json_extract(payload, '$.topic') IS NOT NULL
         AND json_extract(payload, '$.topic') != trim(${norm}, '-');
    `);
  },
};
