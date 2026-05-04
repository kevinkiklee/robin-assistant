// Protocol trigger matcher for the pre-protocol-override hook.
//
// Two exports:
//   loadTriggerMap(repoRoot)  → { protocolName: [phrase, ...] }
//   findMatchingProtocols(promptText, triggerMap) → [{ protocol, phrase }]
//
// Trigger source merge rules (per spec):
//   1. user-data non-empty triggers → wins, system triggers ignored.
//   2. user-data explicit empty `triggers: []` → wins (intentional opt-out).
//   3. user-data missing `triggers:` key → fall back to system triggers.
//
// Matching rules:
//   - Case-insensitive.
//   - Word-boundary (whitespace/punctuation as boundaries) so that phrases
//     don't false-positive inside longer words (e.g., "weeklyreviewer").

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseProtocolFrontmatter } from './protocol-frontmatter.js';

// Files in jobs/ that are not protocols (consistent with listProtocols in
// protocol-frontmatter.js).
function isProtocolFile(name) {
  return name.endsWith('.md') && !name.startsWith('_') && name !== 'README.md';
}

// Parse a protocol file's frontmatter, returning:
//   - { has: true, triggers: [...] }   — triggers key present (possibly empty)
//   - { has: false }                   — triggers key absent
//   - null                             — file unreadable/parse failed
function readProtocolTriggers(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let fm;
  try {
    ({ frontmatter: fm } = parseProtocolFrontmatter(text));
  } catch {
    return null;
  }
  if (!('triggers' in fm)) return { has: false };
  const t = fm.triggers;
  // The frontmatter parser yields an array for `triggers: ["..."]`. If a
  // protocol writer mistypes (e.g., a string), coerce gracefully.
  if (Array.isArray(t)) return { has: true, triggers: t };
  if (typeof t === 'string' && t.length > 0) return { has: true, triggers: [t] };
  return { has: true, triggers: [] };
}

function listProtocolFiles(dir) {
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(isProtocolFile);
}

export function loadTriggerMap(repoRoot) {
  const sysDir = join(repoRoot, 'system', 'jobs');
  const udDir = join(repoRoot, 'user-data', 'runtime', 'jobs');

  const map = Object.create(null);

  // 1. Seed from system protocols.
  for (const name of listProtocolFiles(sysDir)) {
    const protocol = name.replace(/\.md$/, '');
    const got = readProtocolTriggers(join(sysDir, name));
    if (got && got.has) map[protocol] = got.triggers.slice();
    // Files with no triggers key don't appear in the map (lint enforces presence).
  }

  // 2. Apply user-data overrides.
  for (const name of listProtocolFiles(udDir)) {
    const protocol = name.replace(/\.md$/, '');
    const got = readProtocolTriggers(join(udDir, name));
    if (!got) continue;
    if (got.has) {
      // user-data wins on `triggers` key presence (empty array = intentional opt-out).
      map[protocol] = got.triggers.slice();
    } else if (!(protocol in map)) {
      // user-only protocol with no triggers — leave absent (no triggers to match).
    }
    // Otherwise: user-data has no triggers key, system already populated → keep system.
  }

  return map;
}

// Build a regex that matches `phrase` case-insensitively at word boundaries.
// We can't rely solely on \b because phrases contain spaces; emulate with
// (^|[^\w]) ... ($|[^\w]) using lookahead/lookbehind.
function buildPhraseRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i');
}

export function findMatchingProtocols(promptText, triggerMap) {
  if (!promptText || typeof promptText !== 'string') return [];
  const out = [];
  for (const [protocol, phrases] of Object.entries(triggerMap)) {
    if (!Array.isArray(phrases)) continue;
    for (const phrase of phrases) {
      if (typeof phrase !== 'string' || phrase.length === 0) continue;
      let re;
      try {
        re = buildPhraseRegex(phrase);
      } catch {
        continue;
      }
      if (re.test(promptText)) {
        out.push({ protocol, phrase });
      }
    }
  }
  return out;
}
