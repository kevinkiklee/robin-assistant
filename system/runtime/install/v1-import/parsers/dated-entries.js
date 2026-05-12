// dated-entries.js — split a markdown body on `## YYYY-MM-DD` or `### YYYY-MM-DD`
// section headers and return one record per dated section.
//
// Used for v1 streams (journal.md, log.md, decisions.md, inbox.md) and for
// self-improvement/corrections.md. The body of each section is whatever follows
// the header up to (but not including) the next dated header, EOF, or
// `<!-- APPEND-ONLY below -->` sentinel marker.

const HEADER = /^(##|###)\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+?))?\s*$/;

/**
 * @param {string} text
 * @returns {Array<{ date: Date, title: string | null, content: string, line: number }>}
 */
export function parseDatedEntries(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  // Find every header line index.
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER);
    if (m) heads.push({ index: i, date: m[2], title: m[3] ?? null });
  }
  if (heads.length === 0) return [];
  const out = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].index + 1;
    const end = h + 1 < heads.length ? heads[h + 1].index : lines.length;
    const sectionLines = lines.slice(start, end);
    const content = sectionLines.join('\n').trim();
    if (!content) continue;
    const date = parseLocalMidnightUtc(heads[h].date);
    if (!date) continue;
    out.push({ date, title: heads[h].title, content, line: heads[h].index + 1 });
  }
  return out;
}

// Parse `YYYY-MM-DD` to a Date at UTC midnight. We don't apply a TZ shift
// because the v1 journals use local-day semantics but never the time-of-day;
// midnight UTC is a stable, sortable, idempotent anchor.
function parseLocalMidnightUtc(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  const t = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}
