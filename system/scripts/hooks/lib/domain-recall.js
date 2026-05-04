// Domain-trigger recall — parallel pass to entity-alias recall in
// `system/scripts/hooks/claude-code.js` `onUserPromptSubmit`.
//
// The existing entity recall scans the user message for entity *names* and
// aliases (people, projects, places). Domain recall extends that to
// activity / topic *keywords*: "fertilizer" doesn't name an entity but
// should still surface the rooftop garden file, "Roth" should surface the
// finance snapshot, etc. The keyword → file map lives in user-editable
// `user-data/runtime/config/recall-domains.md` (shipped with sensible
// defaults via migration 0028).
//
// Output is a list of file paths to inject. The hook dedupes against
// entity-recall results so the same file isn't injected twice.
//
// Format of recall-domains.md:
//   ## <domain name>
//   keywords: word1, word2, multi word
//   files:
//     - user-data/memory/path/to/file.md
//     - user-data/memory/another/file.md
//
// Sections without keywords or without files are skipped. Malformed maps
// log to caller; recall still fires.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOMAIN_MAP_PATH = 'user-data/runtime/config/recall-domains.md';

// Parse the domain map text into [{ domain, keywords, files }, ...].
// Skips sections missing keywords or files. Returns [] for empty / malformed
// content.
export function parseDomainMap(text) {
  if (!text) return [];
  // Strip frontmatter.
  const fmStripped = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out = [];
  // Split on `## ` headings. Each section starts with the heading line.
  const sections = fmStripped.split(/^## +/m).slice(1);
  for (const section of sections) {
    const headingEnd = section.indexOf('\n');
    if (headingEnd === -1) continue;
    const domain = section.slice(0, headingEnd).trim();
    const body = section.slice(headingEnd + 1);

    const kwMatch = body.match(/^keywords:\s*(.+)$/m);
    if (!kwMatch) continue;
    const keywords = kwMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (keywords.length === 0) continue;

    // Files block: `files:\n  - path\n  - path\n` until the next blank
    // line or section.
    const filesIdx = body.search(/^files:\s*$/m);
    if (filesIdx === -1) continue;
    const filesBody = body.slice(filesIdx).split('\n').slice(1);
    const files = [];
    for (const line of filesBody) {
      const m = line.match(/^\s*-\s+(\S.*?)\s*$/);
      if (m) {
        files.push(m[1]);
      } else if (line.trim() === '' || /^\S/.test(line)) {
        if (files.length > 0) break;
      }
    }
    if (files.length === 0) continue;

    out.push({ domain, keywords, files });
  }
  return out;
}

// Load + parse the domain map for a workspace. Returns [] if the file is
// missing (graceful no-op until migration 0028 has run on a fresh install).
export function loadDomainMap(workspaceDir) {
  const path = join(workspaceDir, DOMAIN_MAP_PATH);
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  try { return parseDomainMap(text); } catch { return []; }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a single case-insensitive regex from a flat keyword list.
// Word-boundary matching at both ends. Multi-word keywords need internal
// whitespace tolerance — we treat any run of whitespace in the keyword as
// `\s+` in the regex.
function buildKeywordRegex(keywords) {
  if (keywords.length === 0) return null;
  const alternatives = keywords.map((k) => escapeRegex(k).replace(/\\?\s+/g, '\\s+'));
  return new RegExp(`\\b(?:${alternatives.join('|')})\\b`, 'i');
}

// Match `text` against the domain map. Returns the unique list of files
// (in domain-declaration order) to inject. Pass `excludeFiles` to dedupe
// against another recall pass (e.g., entity recall).
export function matchDomains(text, domainMap, { excludeFiles = [] } = {}) {
  if (!text || !domainMap || domainMap.length === 0) {
    return { files: [], domainsMatched: [] };
  }
  const exclude = new Set(excludeFiles);
  const files = [];
  const seen = new Set(exclude);
  const domainsMatched = [];
  for (const entry of domainMap) {
    const re = buildKeywordRegex(entry.keywords);
    if (!re) continue;
    if (!re.test(text)) continue;
    domainsMatched.push(entry.domain);
    for (const f of entry.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  return { files, domainsMatched };
}

// Build the contents of the `<!-- relevant memory -->` injection block for
// a list of resolved file paths. Each file is loaded and its content
// truncated at maxBytesPerFile (default 4KB) to keep total injection bounded.
//
// Format mirrors recall.formatRecallHits: bullet per file, but here we
// inject the full file body (truncated) since domain recall is for whole-
// file relevance rather than line hits.
export function formatDomainHits(workspaceDir, files, { maxBytesPerFile = 4096 } = {}) {
  if (!files || files.length === 0) return '';
  const parts = [];
  for (const rel of files) {
    const abs = resolve(workspaceDir, rel);
    if (!existsSync(abs)) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const truncated = text.length > maxBytesPerFile;
    const body = truncated ? `${text.slice(0, maxBytesPerFile)}\n…(truncated)` : text;
    parts.push(`- ${rel}:\n${body}`);
  }
  return parts.join('\n\n');
}

// One-shot: load map, match, format. Returns
// { block: string, files: string[], domainsMatched: string[], bytes: number }
// `block` is empty when nothing matches.
export function runDomainRecall(workspaceDir, text, { excludeFiles = [], maxBytesPerFile = 4096 } = {}) {
  const map = loadDomainMap(workspaceDir);
  const { files, domainsMatched } = matchDomains(text, map, { excludeFiles });
  if (files.length === 0) return { block: '', files: [], domainsMatched: [], bytes: 0 };
  const formatted = formatDomainHits(workspaceDir, files, { maxBytesPerFile });
  if (!formatted) return { block: '', files: [], domainsMatched: [], bytes: 0 };
  const safeDomains = domainsMatched.map((d) => d.replace(/-->/g, '->')).join(', ');
  const block = `<!-- relevant memory: ${files.length} files for domain match: ${safeDomains} -->\n${formatted}\n<!-- /relevant memory -->\n`;
  return { block, files, domainsMatched, bytes: block.length };
}
