/**
 * Letterboxd Diary CSV parser.
 *
 * Required headers (case-insensitive):
 *   Date, Name, Year, Letterboxd URI, Watched Date
 *
 * Optional headers:
 *   Rating, Rewatch, Tags
 *
 * Throws an error with code='NOT_DIARY' if the header row doesn't match.
 */

const REQUIRED_HEADERS = ['date', 'name', 'year', 'letterboxd uri', 'watched date'];

/**
 * Check whether a header line looks like a Letterboxd Diary export.
 * @param {string} headerLine - The first line of the CSV (raw, not yet split).
 * @returns {boolean}
 */
export function isDiaryCsv(headerLine) {
  const cols = parseRow(headerLine).map((h) => h.toLowerCase());
  return REQUIRED_HEADERS.every((req) => cols.includes(req));
}

/**
 * Parse a Letterboxd Diary CSV export.
 * @param {string} text - Full CSV text (header + data rows).
 * @returns {Array<{date: string, name: string, year: string, uri: string, slug: string,
 *   rating: number|null, rewatch: boolean, tags: string[], watched_date: string}>}
 * @throws {Error} with .code='NOT_DIARY' when header doesn't match.
 */
export function parseDiaryCsv(text) {
  const lines = splitLines(text);
  if (lines.length === 0) {
    const err = new Error('Empty CSV');
    err.code = 'NOT_DIARY';
    throw err;
  }

  const headerLine = lines[0];
  if (!isDiaryCsv(headerLine)) {
    const err = new Error('NOT_DIARY: header does not match Letterboxd Diary format');
    err.code = 'NOT_DIARY';
    throw err;
  }

  const headers = parseRow(headerLine).map((h) => h.toLowerCase());
  const idx = (name) => headers.indexOf(name);

  const dateIdx = idx('date');
  const nameIdx = idx('name');
  const yearIdx = idx('year');
  const uriIdx = idx('letterboxd uri');
  const watchedIdx = idx('watched date');
  const ratingIdx = idx('rating');
  const rewatchIdx = idx('rewatch');
  const tagsIdx = idx('tags');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseRow(line);

    const uri = cols[uriIdx] ?? '';
    const slugMatch = uri.match(/\/film\/([^/]+)\//);
    const slug = slugMatch ? slugMatch[1] : '';

    const ratingRaw = ratingIdx >= 0 ? cols[ratingIdx] : '';
    const rating = ratingRaw && ratingRaw.trim() !== '' ? Number(ratingRaw) : null;

    const rewatchRaw = rewatchIdx >= 0 ? cols[rewatchIdx] : '';
    const rewatch = rewatchRaw.trim().toLowerCase() === 'yes';

    const tagsRaw = tagsIdx >= 0 ? cols[tagsIdx] : '';
    const tags = tagsRaw.trim()
      ? tagsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    rows.push({
      date: cols[dateIdx] ?? '',
      name: cols[nameIdx] ?? '',
      year: cols[yearIdx] ?? '',
      uri,
      slug,
      rating: Number.isNaN(rating) ? null : rating,
      rewatch,
      tags,
      watched_date: cols[watchedIdx] ?? '',
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// RFC-4180 minimal parser helpers
// ---------------------------------------------------------------------------

/**
 * Split CSV text into non-empty logical lines, handling quoted fields that
 * span multiple physical lines (RFC-4180 §2.6).
 */
function splitLines(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '"') {
      if (inQuotes && normalized[i + 1] === '"') {
        // Escaped quote inside quoted field.
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Parse a single CSV row into an array of field values.
 * Handles `""` escapes inside quoted fields and commas inside quotes.
 */
function parseRow(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes) {
        if (line[i + 1] === '"') {
          // Escaped double-quote.
          field += '"';
          i += 2;
          continue;
        }
        // Closing quote.
        inQuotes = false;
      } else {
        // Opening quote.
        inQuotes = true;
      }
      i++;
    } else if (ch === ',' && !inQuotes) {
      fields.push(field);
      field = '';
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  fields.push(field);
  return fields;
}
