// Migration 0027: backfill `- qid: <slug>` lines on every entry in
// user-data/memory/self-improvement/learning-queue.md.
//
// Pre-0027 entries (seeded by migration 0014) look like:
//
//   ### 2026-04-30 — Best work time of day
//   - domain: scheduling
//   - why: ...
//   - status: open
//
// Post-0027:
//
//   ### 2026-04-30 — Best work time of day
//   - qid: 2026-04-30-best-work-time-of-day
//   - domain: scheduling
//   - why: ...
//   - status: open
//
// The qid is required by the new Dream learning-queue maintenance flow
// (system/jobs/learning-queue.md) so it can match `[answer|qid=...]`
// markers in inbox.md back to a queue entry.
//
// Idempotent: any entry that already has a `- qid:` line is left alone.
//
// Atomic write: tmp + rename.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qidFromHeading } from '../scripts/lib/learning-queue.js';

export const id = '0027-add-qids-to-learning-queue';
export const description =
  'Backfill `- qid: <slug>` line on each learning-queue entry. Idempotent.';

export async function up({ workspaceDir }) {
  const file = join(workspaceDir, 'user-data/memory/self-improvement/learning-queue.md');
  if (!existsSync(file)) {
    console.log(`[${id}] file missing — no-op`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // First pass: collect existing qids so the collision suffix is correct
  // when we run on a partially-migrated file.
  const existingQids = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^-\s+qid:\s*(\S+)/);
    if (m) existingQids.add(m[1]);
  }

  // Second pass: for each `### ` heading, check the immediately-following
  // bullet block. If no `- qid:` line, insert one as the first bullet.
  const out = [];
  let inserted = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);
    if (!headingMatch) continue;
    // Look ahead for an existing `- qid:` line before the next heading.
    let hasQid = false;
    for (let j = i + 1; j < lines.length; j++) {
      const nextHeading = lines[j].match(/^###\s+/);
      if (nextHeading) break;
      if (/^-\s+qid:\s*\S+/.test(lines[j])) {
        hasQid = true;
        break;
      }
    }
    if (hasQid) continue;
    const qid = qidFromHeading(headingMatch[1], existingQids);
    existingQids.add(qid);
    out.push(`- qid: ${qid}`);
    inserted++;
  }

  if (inserted === 0) {
    console.log(`[${id}] all entries already have qids — no-op`);
    return;
  }

  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, out.join('\n'));
  renameSync(tmp, file);
  console.log(`[${id}] backfilled qids on ${inserted} entries`);
}
