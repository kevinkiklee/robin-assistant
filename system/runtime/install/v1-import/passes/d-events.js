// passes/d-events.js — turn v1 stream files + corrections into v2 events.
//
// Each `## YYYY-MM-DD` (streams) or `### YYYY-MM-DD — title` (corrections)
// section becomes one event with biographed_at=NULL. The heartbeat picks
// them up on its next pass.

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseDatedEntries } from '../parsers/dated-entries.js';
import { parseFrontmatter } from '../parsers/frontmatter.js';
import { createEvent } from '../writers/event-writer.js';

const STREAM_SOURCES = {
  'journal.md': { source: 'v1-journal', breakdown: 'journal' },
  'log.md': { source: 'v1-log', breakdown: 'log' },
  'decisions.md': { source: 'v1-decision', breakdown: 'decision' },
  'inbox.md': { source: 'v1-inbox', breakdown: 'inbox' },
};

export async function passEvents({ memoryDir, db, sessionId, report }) {
  const counts = { created: 0, skipped: 0, undated: 0, errors: 0 };

  // streams/
  const streamsDir = join(memoryDir, 'streams');
  for (const [file, spec] of Object.entries(STREAM_SOURCES)) {
    const { source, breakdown } = spec;
    const p = join(streamsDir, file);
    if (!existsSync(p)) continue;
    const rel = relative(memoryDir, p);
    try {
      const raw = await readFile(p, 'utf8');
      const { body } = parseFrontmatter(raw);
      const entries = parseDatedEntries(body);
      if (entries.length === 0) {
        const mtime = statSync(p).mtime;
        const r = await createEvent(db, {
          source,
          content: body.trim(),
          ts: mtime,
          meta: { source_file: file },
          sourcePath: rel,
          sessionId,
        });
        bumpCounts(counts, report, breakdown, r.action);
        counts.undated++;
        report.warnings.undated_event.push(rel);
        continue;
      }
      // Inbox + log can have many entries on the same date; suffix with the
      // header line number to keep sourcePath (and therefore content_hash)
      // unique. Other streams keep the date-only suffix for stable idempotency.
      const needsLineSuffix = breakdown === 'inbox' || breakdown === 'log';
      for (const entry of entries) {
        const dateSlug = entry.date.toISOString().slice(0, 10);
        const sub = needsLineSuffix ? `${rel}#${dateSlug}-L${entry.line}` : `${rel}#${dateSlug}`;
        const meta = { source_file: file };
        if (entry.title) meta.title = entry.title;
        const r = await createEvent(db, {
          source,
          content: entry.content,
          ts: entry.date,
          meta,
          sourcePath: sub,
          sessionId,
        });
        bumpCounts(counts, report, breakdown, r.action);
      }
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'D', file: rel, message: e.message });
    }
  }

  // self-improvement/corrections.md
  const corr = join(memoryDir, 'self-improvement', 'corrections.md');
  if (existsSync(corr)) {
    const rel = relative(memoryDir, corr);
    try {
      const raw = await readFile(corr, 'utf8');
      const { body } = parseFrontmatter(raw);
      const entries = parseDatedEntries(body);
      for (const entry of entries) {
        const sub = `${rel}#${entry.date.toISOString().slice(0, 10)}-${slugify(entry.title ?? 'untitled')}`;
        const meta = { kind: 'correction', source_file: 'corrections.md' };
        if (entry.title) meta.title = entry.title;
        const r = await createEvent(db, {
          source: 'v1-correction',
          content: entry.content,
          ts: entry.date,
          meta,
          sourcePath: sub,
          sessionId,
        });
        bumpCounts(counts, report, 'correction', r.action);
      }
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'D', file: rel, message: e.message });
    }
  }

  return { counts };
}

function bumpCounts(counts, report, breakdownKey, action) {
  if (action === 'created') {
    counts.created++;
    if (report.breakdown_events && breakdownKey in report.breakdown_events) {
      report.breakdown_events[breakdownKey]++;
    }
  } else if (action === 'skipped') {
    counts.skipped++;
  }
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
