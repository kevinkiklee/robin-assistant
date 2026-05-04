// Helpers for `<workspace>/user-data/runtime/state/needs-your-input.md`.
//
// This file is the single user-facing surface for items Dream wants the user
// to review (action-trust promotion proposals, recall-telemetry alerts,
// conversation pruning candidates, etc.). It replaces the phantom
// "escalation report" referenced in old dream.md prose.
//
// CLAUDE.md startup #4 reads this file last (per-day volatile, cache-friendly).
// When the model sees items here, it surfaces them in the first response of
// the session so the user has a chance to act before auto-finalize deadlines.
//
// Mutations are atomic (tmp + rename) so partial writes never land. All
// section operations are idempotent: re-appending the same section replaces
// rather than duplicates, so daily Dream runs don't pile up duplicate
// "Action-trust promotion proposals" headings.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REL_PATH = 'user-data/runtime/state/needs-your-input.md';

const HEADER = '# Needs your input';
const EMPTY_BODY = '_(no items)_';

export function needsInputPath(workspaceRoot) {
  return join(workspaceRoot, REL_PATH);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function buildFrontmatter(generatedAt = new Date().toISOString()) {
  return `---\ngenerated_at: ${generatedAt}\ngenerated_by: dream\n---\n\n${HEADER}\n\n`;
}

// Parse the file into { frontmatter, sections } where sections is a
// {name: body} map preserving insertion order. Body is the section's raw
// markdown text (without the heading line, with trailing newlines stripped).
function parse(text) {
  if (!text) return { frontmatter: '', sections: {} };
  let frontmatter = '';
  let body = text;
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    frontmatter = fmMatch[0];
    body = text.slice(fmMatch[0].length);
  }
  // Strip the `# Needs your input` top-level heading if present.
  body = body.replace(/^\s*#\s+Needs your input\s*\n+/, '');
  // Split on `## ` headings. JS regex has no \Z; we lookahead for the next
  // `## ` heading or end-of-string.
  const sections = {};
  const re = /^## (.+?)\n([\s\S]*?)(?=^## |$(?![\r\n]))/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].trim();
    const sectionBody = m[2].replace(/\s+$/, '');
    if (!name) continue;
    sections[name] = sectionBody;
  }
  return { frontmatter, sections };
}

// Serialize { frontmatter, sections } back to text. Always rewrites
// frontmatter with a fresh `generated_at`. When sections is empty,
// emits the placeholder body so consumers can detect "nothing to surface."
function serialize(sections) {
  const parts = [buildFrontmatter()];
  const names = Object.keys(sections);
  if (names.length === 0) {
    parts.push(`${EMPTY_BODY}\n`);
  } else {
    for (const name of names) {
      const body = sections[name].replace(/\s+$/, '');
      parts.push(`## ${name}\n\n${body}\n\n`);
    }
  }
  return parts.join('');
}

function load(path) {
  if (!existsSync(path)) return { frontmatter: '', sections: {} };
  return parse(readFileSync(path, 'utf8'));
}

// Append a section. If a section with this name already exists, replace its
// body — Dream re-runs daily and must not duplicate headings.
//
// `body` may be a markdown string (one or more bullets, a paragraph, etc.).
// The serializer normalizes trailing whitespace.
export function appendSection(workspaceRoot, sectionName, body) {
  if (!sectionName || typeof sectionName !== 'string') {
    throw new Error('appendSection: sectionName required');
  }
  const path = needsInputPath(workspaceRoot);
  const { sections } = load(path);
  sections[sectionName] = body;
  atomicWrite(path, serialize(sections));
}

// Remove a section by name. No-op when absent or when the file doesn't exist.
// When the last section is removed, the file is reset to the empty-state
// placeholder so the model knows there's nothing to surface.
export function clearSection(workspaceRoot, sectionName) {
  const path = needsInputPath(workspaceRoot);
  if (!existsSync(path)) return;
  const { sections } = load(path);
  if (!(sectionName in sections)) return;
  delete sections[sectionName];
  atomicWrite(path, serialize(sections));
}

// Reset the file to the empty-state placeholder. Used by Dream Phase 0 in
// its most aggressive form (rare); prefer clearSection for targeted clears
// so unrelated sections survive.
export function clearFile(workspaceRoot) {
  atomicWrite(needsInputPath(workspaceRoot), serialize({}));
}

// Read all sections as { name: body }. Returns {} when the file is missing
// or contains only the empty-state placeholder.
export function readSections(workspaceRoot) {
  return load(needsInputPath(workspaceRoot)).sections;
}
