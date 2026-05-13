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

// Pure index/catalogue files that have no content of their own — re-derivable in v2.
// `tasks.md` was previously here but contains active open tasks that aren't
// derivable from anywhere else, so it now imports by default.
const SKIPPED_VIEW_FILES = new Set([
  'INDEX.md',
  'MANIFEST.md',
  'LINKS.md',
  'ENTITIES.md',
  'hot.md',
  'people.md',
  'relationships.md',
]);

// self-improvement/<file> → (kind, meta) for files not already handled by
// passes D/E. communication-style.md is omitted here because it's routed
// through applyFacet (persona projector) below.
const SELF_IMPROVEMENT_FILES = {
  'threads.md': { kind: 'pattern', meta: { source: 'biographer-threads' } },
  'domain-confidence.md': { kind: 'knowledge', meta: { source: 'domain-confidence' } },
  'learning-queue.md': { kind: 'knowledge', meta: { source: 'learning-queue' } },
  'session-handoff.md': { kind: 'knowledge', meta: { source: 'session-handoff' } },
};

export async function passMemos({
  memoryDir,
  entitiesByPath,
  db,
  sessionId,
  report,
  includeViews = false,
}) {
  const counts = {
    memos_created: 0,
    memos_skipped: 0,
    edges: 0,
    about_edges: 0,
    derived_from_edges: 0,
    chunked: 0,
    errors: 0,
  };

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

  // 6. self-improvement/communication-style.md → persona facet (routes through
  //    PERSONA_FACET_MAP['communication-style'] = commStyleProjector) + memo
  const commStylePath = join(memoryDir, 'self-improvement', 'communication-style.md');
  try {
    const raw = await readFile(commStylePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const trimmed = body.trim();
    if (trimmed) {
      const rel = relative(memoryDir, commStylePath);
      const result = await applyFacet(db, {
        facet_slug: 'communication-style',
        body: trimmed,
        frontmatter,
        sourcePath: rel,
        sessionId,
      });
      if (result.memo.action === 'created') counts.memos_created++;
      else counts.memos_skipped++;
    }
  } catch {
    /* missing self-improvement/communication-style.md is fine */
  }

  // 7. self-improvement/{threads,domain-confidence,learning-queue,session-handoff}.md
  for (const [file, spec] of Object.entries(SELF_IMPROVEMENT_FILES)) {
    const filePath = join(memoryDir, 'self-improvement', file);
    const rel = relative(memoryDir, filePath);
    try {
      const raw = await readFile(filePath, 'utf8');
      const { body } = parseFrontmatter(raw);
      const trimmed = body.trim();
      if (!trimmed) continue;
      await writeChunkedMemo({
        rel,
        content: trimmed,
        kind: spec.kind,
        meta: spec.meta,
        db,
        sessionId,
        counts,
        report,
      });
    } catch (e) {
      if (e.code !== 'ENOENT') {
        counts.errors++;
        report.errors.push({ pass: 'B', file: rel, message: e.message });
      }
    }
  }

  // 8. memory/tasks.md — active task list (open [ ] items aren't derivable elsewhere)
  const tasksPath = join(memoryDir, 'tasks.md');
  try {
    const raw = await readFile(tasksPath, 'utf8');
    const { body } = parseFrontmatter(raw);
    const trimmed = body.trim();
    if (trimmed) {
      const rel = relative(memoryDir, tasksPath);
      await writeChunkedMemo({
        rel,
        content: trimmed,
        kind: 'knowledge',
        meta: { source: 'v1-tasks' },
        db,
        sessionId,
        counts,
        report,
      });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      counts.errors++;
      report.errors.push({ pass: 'B', file: 'tasks.md', message: e.message });
    }
  }

  // 9. memory.surrealdb-era/** — historical photo-collection audit/proposals/scans
  //    not duplicated elsewhere. Imported as low-confidence knowledge memos.
  const surrealEraDir = join(memoryDir, '..', 'memory.surrealdb-era');
  for await (const filePath of walkMarkdown(surrealEraDir)) {
    if (basename(filePath) === 'INDEX.md') continue;
    if (basename(filePath) === 'ENTITIES.md') continue;
    const rel = `memory.surrealdb-era/${relative(surrealEraDir, filePath)}`;
    try {
      const raw = await readFile(filePath, 'utf8');
      const { body } = parseFrontmatter(raw);
      const trimmed = body.trim();
      if (!trimmed) continue;
      const r = await createMemo(db, {
        kind: 'knowledge',
        content: trimmed,
        confidence: 0.3,
        meta: { archived: true, source: 'memory.surrealdb-era' },
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

async function writeChunkedMemo({ rel, content, kind, meta, db, sessionId, counts, report }) {
  if (!needsChunking(content)) {
    const r = await createMemo(db, {
      kind,
      content,
      meta,
      sourcePath: rel,
      sessionId,
    });
    if (r.action === 'created') counts.memos_created++;
    else counts.memos_skipped++;
    return;
  }

  counts.chunked++;
  report.warnings.long_content_chunked.push(rel);
  const chunks = splitAtParagraphs(content);
  const parent = await createMemo(db, {
    kind,
    content: chunks[0],
    meta: { ...meta, chunked: true, total_chunks: chunks.length },
    sourcePath: rel,
    sessionId,
  });
  if (parent.action === 'created') counts.memos_created++;
  else counts.memos_skipped++;
  for (let i = 1; i < chunks.length; i++) {
    const child = await createMemo(db, {
      kind,
      content: chunks[i],
      meta: { ...meta, parent_chunk: i, total_chunks: chunks.length },
      sourcePath: `${rel}#chunk-${i}`,
      sessionId,
    });
    if (child.action === 'created') counts.memos_created++;
    else counts.memos_skipped++;
    if (parent.id && child.id) {
      await upsertEdge(db, { from: child.id, to: parent.id, kind: 'derived_from' });
      counts.edges++;
      counts.derived_from_edges++;
    }
  }
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
      counts.about_edges++;
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
    counts.about_edges++;
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
      counts.derived_from_edges++;
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
