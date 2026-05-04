// Helpers for the Learning Queue (driven by Dream daily maintenance).
//
// The queue lives at:
//   user-data/memory/self-improvement/learning-queue.md
//
// Today's surfaced question lives at:
//   user-data/runtime/state/learning-queue/today.md
//
// CLAUDE.md startup #4 reads today.md (when present) into Tier 1, so the
// model sees the question at session start and asks it when a natural
// moment arises. The model captures the user's answer with:
//   [answer|qid=<qid>|<original-tag>|origin=user] <answer text>
//
// Dream's next run scans inbox.md for these markers, calls markAnswered to
// flip the queue entry, and routes the answer to the right destination
// file (preferences.md / decisions.md / corrections.md / inbox.md).
//
// All file mutations are atomic (tmp + rename) — never leave a partial
// learning-queue.md or today.md on disk. Concurrent Dream runs are
// already serialized by the runner lockfile, so we don't need an in-helper
// lock; atomicity is purely against process crashes mid-write.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const QUEUE_REL = 'user-data/memory/self-improvement/learning-queue.md';
const TODAY_REL = 'user-data/runtime/state/learning-queue/today.md';

// Stopwords used by the keyword-overlap scoring. Intentionally small —
// just the most common English filler words. Anything longer than a few
// dozen entries starts to remove signal more than noise.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i',
  'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'vs', 'was', 'what', 'when', 'where', 'why', 'with', 'you', 'your',
]);

function tokens(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function queuePath(workspaceRoot) {
  return join(workspaceRoot, QUEUE_REL);
}

function todayPath(workspaceRoot) {
  return join(workspaceRoot, TODAY_REL);
}

// Atomic write: write to <path>.tmp-<pid>, then rename. rename(2) on POSIX
// is atomic when src and dst are on the same filesystem, which they are
// for sibling files in the same directory.
function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Slugify a string into a qid-safe form: lowercase, ASCII only, hyphens
// for separators, no leading/trailing/repeated hyphens.
function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// Build a qid from an entry heading. Format: <date>-<title-slug>.
// Accepts headings with or without a leading "### " prefix.
// Separator can be em-dash (—), en-dash (–), or ASCII " - ".
// Collision handling: if the slug is already in `existingQids`, append a
// 2-char base36 suffix derived deterministically from the heading.
export function qidFromHeading(heading, existingQids) {
  const cleaned = heading.replace(/^#+\s*/, '').trim();
  // Try em-dash, en-dash, then ASCII " - " (with surrounding spaces) in
  // order. Fall back to whitespace if no separator is found.
  let date;
  let title;
  for (const sep of ['—', '–', ' - ']) {
    const idx = cleaned.indexOf(sep);
    if (idx !== -1) {
      date = cleaned.slice(0, idx).trim();
      title = cleaned.slice(idx + sep.length).trim();
      break;
    }
  }
  if (date === undefined) {
    // No separator — assume first whitespace splits date from title.
    const idx = cleaned.indexOf(' ');
    if (idx === -1) {
      date = cleaned;
      title = '';
    } else {
      date = cleaned.slice(0, idx).trim();
      title = cleaned.slice(idx + 1).trim();
    }
  }
  const titleSlug = slugify(title);
  let base = titleSlug ? `${date}-${titleSlug}` : date;
  if (!existingQids.has(base)) return base;
  // Deterministic 2-char suffix derived from the full heading. djb2-style
  // string hash → base36.
  let hash = 5381;
  for (let i = 0; i < heading.length; i++) {
    hash = ((hash << 5) + hash + heading.charCodeAt(i)) & 0xffffffff;
  }
  const suffix = (Math.abs(hash) % (36 * 36)).toString(36).padStart(2, '0');
  return `${base}-${suffix}`;
}

// Parse a learning-queue.md file into structured entries.
// Each entry is a `### YYYY-MM-DD — Title` heading followed by a list of
// `- key: value` lines (terminated by the next heading or EOF).
// Returns: [{qid, question, why, domain, status, added, answered?, answer?, route?, dropped?, dropped_reason?, lineStart, lineEnd}]
function parseQueueText(text) {
  const lines = text.split('\n');
  const entries = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) {
        current.lineEnd = i - 1;
        entries.push(current);
      }
      const heading = headingMatch[1];
      // Extract title (after first separator) for `question` field.
      let question = heading;
      for (const sep of ['—', '–', ' - ']) {
        const idx = heading.indexOf(sep);
        if (idx !== -1) {
          question = heading.slice(idx + sep.length).trim();
          break;
        }
      }
      current = { heading, question, lineStart: i, lineEnd: i };
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^-\s+([\w-]+):\s*(.*)$/);
    if (kv) {
      let value = kv[2].trim();
      // Strip optional surrounding quotes.
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        // Unescape \"
        value = value.slice(1, -1).replace(/\\"/g, '"');
      }
      current[kv[1]] = value;
    }
  }
  if (current) {
    current.lineEnd = lines.length - 1;
    entries.push(current);
  }
  return entries;
}

export function loadQueue(workspaceRoot) {
  const path = queuePath(workspaceRoot);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return parseQueueText(text);
}

// Compute selection score for a single (question, captures) pair.
function scoreQuestion(q, captures) {
  let score = 0;
  const qTokens = new Set(tokens(q.question || ''));
  for (const cap of captures) {
    if (q.domain && cap.domain && q.domain === cap.domain) {
      score += 2;
    }
    const capTokens = tokens(cap.text || '');
    let overlap = 0;
    for (const t of capTokens) {
      if (qTokens.has(t)) overlap++;
      if (overlap >= 2) break;
    }
    if (overlap >= 2) score += 1;
  }
  return score;
}

// Pick today's question. Returns null when no open questions exist.
// `captures`: array of { domain?, text? } objects representing recent
// signals (last 24h of inbox/journal/decisions/tasks). Approximation is
// fine — Dream feeds in dated entries and we don't need precise mtime.
// `today`: YYYY-MM-DD string, used as the tiebreaker fallback when added
// dates equal each other.
export function pickToday(queue, captures, today) {
  const open = queue.filter((q) => q.status === 'open');
  if (open.length === 0) return null;
  const scored = open.map((q) => ({ q, score: scoreQuestion(q, captures) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Oldest added first.
    const aAdded = a.q.added || '9999-99-99';
    const bAdded = b.q.added || '9999-99-99';
    if (aAdded !== bAdded) return aAdded < bAdded ? -1 : 1;
    // qid lexical.
    const aQid = a.q.qid || '';
    const bQid = b.q.qid || '';
    return aQid < bQid ? -1 : aQid > bQid ? 1 : 0;
  });
  return scored[0].q;
}

// Render the today.md body for a picked item. Markdown shape per spec.
function renderToday(item, generatedAt) {
  const tag = item.original_tag || 'fact';
  const lines = [
    '---',
    `generated_at: ${generatedAt}`,
    `qid: ${item.qid}`,
  ];
  if (item.domain) lines.push(`domain: ${item.domain}`);
  lines.push('---');
  lines.push('');
  lines.push("# Today's learning question");
  lines.push('');
  lines.push(`**Question:** ${item.question || '(missing)'}`);
  lines.push('');
  if (item.why) {
    lines.push(`**Why this matters:** ${item.why}`);
    lines.push('');
  }
  lines.push('**How to answer:** Look for a natural moment in this session to bring it up');
  lines.push('(if you\'re already discussing the topic above, that\'s a great time).');
  lines.push("When the user gives a substantive answer, capture as:");
  lines.push('');
  lines.push(`  [answer|qid=${item.qid}|${tag}|origin=user] <answer>`);
  lines.push('');
  lines.push('If the user dismisses or signals "not now," do NOT re-ask this session.');
  lines.push('');
  return lines.join('\n');
}

export function writeToday(workspaceRoot, item, generatedAt) {
  const body = renderToday(item, generatedAt);
  atomicWrite(todayPath(workspaceRoot), body);
}

// Read today.md and return { qid, domain, question, body } or null.
export function readToday(workspaceRoot) {
  const path = todayPath(workspaceRoot);
  if (!existsSync(path)) return null;
  const body = readFileSync(path, 'utf8');
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n?/);
  const out = { body };
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
  }
  const qMatch = body.match(/\*\*Question:\*\*\s*(.+)/);
  if (qMatch) out.question = qMatch[1].trim();
  return out;
}

export function clearToday(workspaceRoot) {
  const path = todayPath(workspaceRoot);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

// Mark a queue entry as answered. Atomic in-place rewrite.
// Returns true if a matching open entry was updated, false otherwise.
// Manually-edited (already answered/dropped) entries are NOT overwritten.
export function markAnswered(workspaceRoot, qid, { answer, route, date }) {
  const path = queuePath(workspaceRoot);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const entries = parseQueueText(text);
  const target = entries.find((e) => e.qid === qid);
  if (!target) return false;
  if (target.status !== 'open') return false;
  const lines = text.split('\n');
  const escaped = (answer || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const newBlock = [];
  for (let i = target.lineStart; i <= target.lineEnd; i++) {
    let line = lines[i];
    if (/^-\s+status:/.test(line)) {
      newBlock.push('- status: answered');
      continue;
    }
    newBlock.push(line);
  }
  // Append answered/answer/route after the block. Drop any trailing blank
  // line that belonged to the original block to keep spacing consistent.
  while (newBlock.length > 0 && newBlock[newBlock.length - 1].trim() === '') {
    newBlock.pop();
  }
  newBlock.push(`- answered: ${date}`);
  newBlock.push(`- answer: "${escaped}"`);
  newBlock.push(`- route: ${route}`);
  // Reassemble: lines before, newBlock, lines after.
  const before = lines.slice(0, target.lineStart);
  const after = lines.slice(target.lineEnd + 1);
  // Preserve a single blank-line separator between blocks if there was one.
  const rebuilt = [...before, ...newBlock];
  if (after.length > 0 && (after[0].trim() !== '' || after.length > 1)) {
    rebuilt.push('');
  }
  rebuilt.push(...after);
  atomicWrite(path, rebuilt.join('\n'));
  return true;
}

// Flip open questions older than ageDays to status: dropped. Returns count.
// `today` is YYYY-MM-DD; we compare day-granularity (good enough at Dream
// cadence — false-positive risk is at most one extra day).
export function retireStale(workspaceRoot, ageDays, today) {
  const path = queuePath(workspaceRoot);
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, 'utf8');
  const entries = parseQueueText(text);
  if (entries.length === 0) return 0;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(todayMs)) throw new Error(`retireStale: invalid today=${today}`);
  let lines = text.split('\n');
  let count = 0;
  // Process in reverse so line indices stay valid as we splice.
  const toRetire = entries.filter((e) => {
    if (e.status !== 'open') return false;
    if (!e.added) return false;
    const addedMs = Date.parse(`${e.added}T00:00:00Z`);
    if (Number.isNaN(addedMs)) return false;
    const ageDaysActual = (todayMs - addedMs) / (24 * 3600 * 1000);
    return ageDaysActual > ageDays;
  });
  toRetire.sort((a, b) => b.lineStart - a.lineStart);
  for (const e of toRetire) {
    const newBlock = [];
    for (let i = e.lineStart; i <= e.lineEnd; i++) {
      const line = lines[i];
      if (/^-\s+status:/.test(line)) {
        newBlock.push('- status: dropped');
      } else {
        newBlock.push(line);
      }
    }
    while (newBlock.length > 0 && newBlock[newBlock.length - 1].trim() === '') {
      newBlock.pop();
    }
    newBlock.push(`- dropped: ${today}`);
    newBlock.push(`- dropped_reason: "stale, never answered"`);
    const before = lines.slice(0, e.lineStart);
    const after = lines.slice(e.lineEnd + 1);
    const rebuilt = [...before, ...newBlock];
    if (after.length > 0 && (after[0].trim() !== '' || after.length > 1)) {
      rebuilt.push('');
    }
    rebuilt.push(...after);
    lines = rebuilt;
    count++;
  }
  if (count > 0) atomicWrite(path, lines.join('\n'));
  return count;
}

// Map an `<original-tag>` (from the answer marker) to a destination file.
// Returns null when the destination is content-dependent — Dream chooses
// the right profile/* or knowledge/* file at runtime.
export function routeFromTag(tag) {
  switch (tag) {
    case 'preference':
      return 'user-data/memory/self-improvement/preferences.md';
    case 'decision':
      return 'user-data/memory/streams/decisions.md';
    case 'correction':
      return 'user-data/memory/self-improvement/corrections.md';
    case 'fact':
    case 'update':
      return null;
    default:
      return 'user-data/memory/streams/inbox.md';
  }
}
