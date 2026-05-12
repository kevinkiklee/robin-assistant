// passes/e-rules-patterns.js — preferences → rules, patterns → memos,
// quarantine → refusals.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseFrontmatter } from '../parsers/frontmatter.js';
import { parseListOfEntries } from '../parsers/list-of-entries.js';
import { detectRuleKind } from '../taxonomy.js';
import { createMemo } from '../writers/memo-writer.js';
import { createRefusal } from '../writers/refusal-writer.js';
import { createRule } from '../writers/rule-writer.js';

export async function passRulesPatterns({ memoryDir, db, sessionId, report }) {
  const counts = { rules: 0, patterns: 0, refusals: 0, errors: 0 };

  // self-improvement/preferences.md → rules
  const prefsPath = join(memoryDir, 'self-improvement', 'preferences.md');
  if (existsSync(prefsPath)) {
    const rel = relative(memoryDir, prefsPath);
    try {
      const raw = await readFile(prefsPath, 'utf8');
      const { body } = parseFrontmatter(raw);
      const entries = parseListOfEntries(body);
      for (const e of entries) {
        const kind = detectRuleKind(e.content);
        const sub = `${rel}#${slugify(e.title ?? `line-${e.line}`)}`;
        const r = await createRule(db, {
          content: e.content,
          kind,
          meta: { source: 'v1-preferences', title: e.title ?? null },
          sourcePath: sub,
          sessionId,
        });
        if (r.action === 'created') counts.rules++;
      }
    } catch (err) {
      counts.errors++;
      report.errors.push({ pass: 'E', file: rel, message: err.message });
    }
  }

  // self-improvement/patterns.md → memos(kind='pattern')
  const patternsPath = join(memoryDir, 'self-improvement', 'patterns.md');
  if (existsSync(patternsPath)) {
    const rel = relative(memoryDir, patternsPath);
    try {
      const raw = await readFile(patternsPath, 'utf8');
      const { body } = parseFrontmatter(raw);
      const entries = parseListOfEntries(body);
      for (const e of entries) {
        const sub = `${rel}#${slugify(e.title ?? `line-${e.line}`)}`;
        const r = await createMemo(db, {
          kind: 'pattern',
          content: e.content,
          meta: { title: e.title ?? null },
          sourcePath: sub,
          sessionId,
        });
        if (r.action === 'created') counts.patterns++;
      }
    } catch (err) {
      counts.errors++;
      report.errors.push({ pass: 'E', file: rel, message: err.message });
    }
  }

  // memory/quarantine/** → refusals
  const quarantineDir = join(memoryDir, 'quarantine');
  for await (const filePath of walkMarkdown(quarantineDir)) {
    const rel = relative(memoryDir, filePath);
    try {
      const raw = await readFile(filePath, 'utf8');
      const { body } = parseFrontmatter(raw);
      const trimmed = body.trim();
      if (!trimmed) continue;
      const r = await createRefusal(db, {
        content: trimmed,
        sourcePath: rel,
        sessionId,
      });
      if (r.action === 'created') counts.refusals++;
    } catch (err) {
      counts.errors++;
      report.errors.push({ pass: 'E', file: rel, message: err.message });
    }
  }

  return { counts };
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

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
