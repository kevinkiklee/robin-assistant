// passes/b-memos.js — create memos + about edges + persona facets.
//
// One memo per source file. Long-content files (>CHUNK_THRESHOLD) emit a
// parent memo plus N child chunk memos linked via derived_from edges.

import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { needsChunking, splitAtParagraphs } from '../chunk.js';
import { parseFrontmatter } from '../parsers/frontmatter.js';
import { confidenceForDecay } from '../taxonomy.js';
import { upsertEdge } from '../writers/edge-writer.js';
import { createMemo } from '../writers/memo-writer.js';
import { applyFacet } from '../writers/persona-writer.js';

const SKIPPED_VIEW_FILES = new Set([
  'INDEX.md',
  'MANIFEST.md',
  'LINKS.md',
  'ENTITIES.md',
  'hot.md',
  'tasks.md',
  'people.md',
  'relationships.md',
]);

export async function passMemos({
  memoryDir,
  entitiesByPath,
  db,
  sessionId,
  report,
  includeViews = false,
}) {
  const counts = { memos_created: 0, memos_skipped: 0, edges: 0, chunked: 0, errors: 0 };

  // 1. knowledge/** — memo per file + about edge
  const knowledgeDir = join(memoryDir, 'knowledge');
  for await (const filePath of walkMarkdown(knowledgeDir)) {
    if (!includeViews && SKIPPED_VIEW_FILES.has(basename(filePath))) continue;
    const rel = relative(memoryDir, filePath);
    try {
      await writeKnowledgeMemo({ filePath, rel, entitiesByPath, db, sessionId, counts, report });
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'B', file: rel, message: e.message });
    }
  }

  // 2. profile/<facet>.md — persona facets + body memos
  const profileDir = join(memoryDir, 'profile');
  let profileEntries = [];
  try {
    profileEntries = await readdir(profileDir, { withFileTypes: true });
  } catch {
    /* missing */
  }
  for (const ent of profileEntries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    if (!includeViews && SKIPPED_VIEW_FILES.has(ent.name)) continue;
    const filePath = join(profileDir, ent.name);
    const rel = relative(memoryDir, filePath);
    const slug = basename(ent.name, '.md');
    try {
      const raw = await readFile(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const result = await applyFacet(db, {
        facet_slug: slug,
        body,
        frontmatter,
        sourcePath: rel,
        sessionId,
      });
      if (result.memo.action === 'created') counts.memos_created++;
      else if (result.memo.action === 'skipped') counts.memos_skipped++;
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'B', file: rel, message: e.message });
    }
  }

  // 3. profile/people/** — body memo + about edge
  const peopleDir = join(memoryDir, 'profile', 'people');
  for await (const filePath of walkMarkdown(peopleDir)) {
    if (basename(filePath) === 'INDEX.md') continue;
    const rel = relative(memoryDir, filePath);
    try {
      await writeKnowledgeMemo({ filePath, rel, entitiesByPath, db, sessionId, counts, report });
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'B', file: rel, message: e.message });
    }
  }

  // 4. watches/log.md — kind=thread memos for each entry (legacy-thread shape)
  const watchesLog = join(memoryDir, 'watches', 'log.md');
  try {
    const raw = await readFile(watchesLog, 'utf8');
    const { body } = parseFrontmatter(raw);
    const rel = relative(memoryDir, watchesLog);
    // Treat the whole log as one thread memo for now; sub-bullets stay together.
    const trimmed = body.trim();
    if (trimmed) {
      const r = await createMemo(db, {
        kind: 'thread',
        content: trimmed,
        meta: { status: 'watching', kind: 'watch' },
        sourcePath: rel,
        sessionId,
      });
      if (r.action === 'created') counts.memos_created++;
      else counts.memos_skipped++;
    }
  } catch {
    /* missing watches/log.md is fine */
  }

  // 5. memory/archive/** — low-confidence knowledge memos
  const archiveDir = join(memoryDir, 'archive');
  for await (const filePath of walkMarkdown(archiveDir)) {
    if (basename(filePath) === 'INDEX.md') continue;
    const rel = relative(memoryDir, filePath);
    try {
      const raw = await readFile(filePath, 'utf8');
      const { body } = parseFrontmatter(raw);
      const trimmed = body.trim();
      if (!trimmed) continue;
      const r = await createMemo(db, {
        kind: 'knowledge',
        content: trimmed,
        confidence: 0.3,
        meta: { archived: true },
        sourcePath: rel,
        sessionId,
      });
      if (r.action === 'created') counts.memos_created++;
      else counts.memos_skipped++;
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'B', file: rel, message: e.message });
    }
  }

  return { counts };
}

async function writeKnowledgeMemo({
  filePath,
  rel,
  entitiesByPath,
  db,
  sessionId,
  counts,
  report,
}) {
  const raw = await readFile(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const content = body.trim();
  if (!content) return;
  const decay = frontmatter?.decay;
  const decayAnchor = parseDate(frontmatter?.last_verified);
  const entity = entitiesByPath.get(rel);

  if (!needsChunking(content)) {
    const r = await createMemo(db, {
      kind: 'knowledge',
      content,
      confidence: confidenceForDecay(decay),
      decayAnchor,
      sourcePath: rel,
      sessionId,
    });
    if (r.action === 'created') counts.memos_created++;
    else counts.memos_skipped++;
    if (entity && r.id) {
      await upsertEdge(db, { from: r.id, to: entity.id, kind: 'about' });
      counts.edges++;
    }
    return;
  }

  // Chunked: parent + N children, linked via derived_from.
  counts.chunked++;
  report.warnings.long_content_chunked.push(rel);
  const chunks = splitAtParagraphs(content);
  const parentLead = chunks[0]; // first chunk doubles as the parent's body
  const parent = await createMemo(db, {
    kind: 'knowledge',
    content: parentLead,
    confidence: confidenceForDecay(decay),
    decayAnchor,
    meta: { chunked: true, total_chunks: chunks.length },
    sourcePath: rel,
    sessionId,
  });
  if (parent.action === 'created') counts.memos_created++;
  else counts.memos_skipped++;
  if (entity && parent.id) {
    await upsertEdge(db, { from: parent.id, to: entity.id, kind: 'about' });
    counts.edges++;
  }
  for (let i = 1; i < chunks.length; i++) {
    const child = await createMemo(db, {
      kind: 'knowledge',
      content: chunks[i],
      confidence: confidenceForDecay(decay),
      decayAnchor,
      meta: { parent_chunk: i, total_chunks: chunks.length },
      sourcePath: `${rel}#chunk-${i}`,
      sessionId,
    });
    if (child.action === 'created') counts.memos_created++;
    else counts.memos_skipped++;
    if (parent.id && child.id) {
      await upsertEdge(db, { from: child.id, to: parent.id, kind: 'derived_from' });
      counts.edges++;
    }
  }
}

async function* walkMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

function parseDate(s) {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
