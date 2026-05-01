// Regenerate the <!-- BEGIN compact-summary --> ... <!-- END compact-summary -->
// block in policies.md from the body's AUTO/ASK/NEVER bullet lists.
//
// The block is the Tier 1 view of policies — the only part the agent reads
// at session start. The body remains the user-editable source of truth.

import { readFileSync } from 'node:fs';
import { writeIfChanged } from '../jobs/atomic.js';

const SECTION_RE = /^##\s+(AUTO|ASK|NEVER)\s*$/i;
const BULLET_RE = /^-\s+([a-z0-9][a-z0-9-]*)/i;
const BEGIN_MARK = '<!-- BEGIN compact-summary (Dream-maintained — DO NOT EDIT BY HAND) -->';
const END_MARK = '<!-- END compact-summary -->';

export function parsePolicies(body) {
  const out = { auto: [], ask: [], never: [] };
  let section = null;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd(); // strip trailing inline comments
    const sec = line.match(SECTION_RE);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    if (!section) continue;
    const m = line.match(BULLET_RE);
    if (!m) continue;
    out[section].push(m[1]);
  }
  return out;
}

export function buildSummary({ auto, never }) {
  const autoStr = auto.length ? auto.join(', ') : '(none)';
  const neverStr = never.length ? never.join(', ') : '(none)';
  return `${BEGIN_MARK}\nAUTO: ${autoStr}\nNEVER: ${neverStr}\n${END_MARK}`;
}

function splitFrontmatter(content) {
  if (!content.startsWith('---\n')) return { frontmatter: '', body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return { frontmatter: '', body: content };
  return {
    frontmatter: content.slice(0, end + 5),
    body: content.slice(end + 5),
  };
}

function stripExistingBlock(body) {
  const beginIdx = body.indexOf('<!-- BEGIN compact-summary');
  if (beginIdx < 0) return body;
  const endTag = '<!-- END compact-summary -->';
  const endIdx = body.indexOf(endTag, beginIdx);
  if (endIdx < 0) return body;
  const after = endIdx + endTag.length;
  // Strip a trailing newline pair if present so we don't accumulate blank lines.
  let tail = body.slice(after);
  if (tail.startsWith('\n\n')) tail = tail.slice(1);
  return body.slice(0, beginIdx) + tail;
}

export async function regenerateCompactSummary(policiesPath) {
  const content = readFileSync(policiesPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(content);
  const policies = parsePolicies(body);
  const summary = buildSummary(policies);
  const cleanedBody = stripExistingBlock(body);
  // Insert block immediately after frontmatter (one blank line between).
  // Normalise the leading whitespace so exactly one '\n' precedes the body content,
  // preventing blank-line accumulation across repeated runs.
  const normBody = '\n' + cleanedBody.replace(/^\n+/, '');
  const next = `${frontmatter}\n${summary}${normBody}`;
  writeIfChanged(policiesPath, next);
}
