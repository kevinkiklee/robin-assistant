#!/usr/bin/env node
// system/tests/replay/tag-fixtures.mjs
//
// One-shot script: tag each v1-quarantine fixture entry with the most-likely
// expected_rule_id from the rules table. Uses a date-bucketed jaccard
// similarity match — no embedder dependency.
//
// Run via: `node system/tests/replay/tag-fixtures.mjs`
// Idempotent — safe to re-run; assignments stable for the same DB state.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { close, connect, defaultDbUrl } from '../../data/db/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, 'fixtures/v1-quarantine-corrections.json');

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'about',
  'and',
  'or',
  'but',
  'not',
  'no',
  'so',
  'as',
  'if',
  'than',
  'then',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'their',
  'his',
  'her',
  'i',
  'me',
  'my',
  'we',
  'us',
  'our',
  'you',
  'your',
  'they',
  'them',
  'do',
  'does',
  'did',
  'doing',
  'done',
  'have',
  'has',
  'had',
  'having',
  'will',
  'would',
  'should',
  'could',
  'may',
  'might',
  'must',
  'when',
  'where',
  'why',
  'how',
  'what',
  'who',
  'which',
  'all',
  'any',
  'each',
  'every',
  'some',
  'one',
  'two',
  'just',
  'into',
  'over',
  'under',
  'between',
  'after',
  'before',
  'during',
]);

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Extract YYYY-MM-DD from rule content like "[preference] (2026-05-08 01:27) ..."
function extractDate(content) {
  const m = /\((\d{4}-\d{2}-\d{2})/.exec(content || '');
  return m ? m[1] : null;
}

function dateFromTimestamp(ts) {
  return String(ts || '').slice(0, 10);
}

async function main() {
  const fixturesRaw = await readFile(FIXTURES_PATH, 'utf8');
  const corpus = JSON.parse(fixturesRaw);

  const db = await connect({ engine: await defaultDbUrl() });
  const [ruleRows] = await db.query('SELECT id, content FROM rules WHERE active = true').collect();
  await close(db);

  console.log(`Loaded ${corpus.entries.length} fixture entries and ${ruleRows.length} rules.`);

  const rules = ruleRows.map((r) => ({
    id: String(r.id),
    content: r.content,
    date: extractDate(r.content),
    tokens: tokenize(r.content),
  }));

  const MIN_JACCARD = 0.05;
  let tagged = 0;
  let unmatched = 0;

  for (const entry of corpus.entries) {
    const fixtureTokens = tokenize(entry.content);
    const fixtureDate = dateFromTimestamp(entry.timestamp);

    let bestRule = null;
    let bestScore = MIN_JACCARD;
    let dateBoost = 0;

    for (const rule of rules) {
      let score = jaccard(fixtureTokens, rule.tokens);
      if (rule.date && fixtureDate && rule.date === fixtureDate) {
        score += 0.1; // small same-day boost
        dateBoost++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestRule = rule;
      }
    }

    if (bestRule) {
      entry.expected_rule_id = bestRule.id;
      entry.expected_rule_match = { score: Number(bestScore.toFixed(3)), strategy: 'jaccard+date' };
      tagged++;
    } else {
      entry.expected_rule_id = null;
      unmatched++;
    }
  }

  corpus.tagging = {
    tagged_at: new Date().toISOString(),
    method: 'jaccard token similarity + same-day boost',
    rules_considered: rules.length,
    fixtures_tagged: tagged,
    fixtures_unmatched: unmatched,
  };

  await writeFile(FIXTURES_PATH, JSON.stringify(corpus, null, 2) + '\n', 'utf8');
  console.log(`Tagged ${tagged}, left ${unmatched} unmatched. Wrote ${FIXTURES_PATH}.`);
}

main().catch((e) => {
  console.error('tag-fixtures failed:', e);
  process.exit(1);
});
