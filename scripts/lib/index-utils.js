/**
 * index-utils.js — utilities for Robin's memory indexing system.
 *
 * Covers:
 *   - ID generation (generateEntryId, generateMigrationId)
 *   - Entry parsing (parseAppendOnlyEntries, parseReferenceEntries, parseTaskEntries)
 *   - ID injection  (injectIdIntoLine, injectIdBeforeBlock, injectIdsIntoFile)
 *   - Index file I/O (generateSkeletonIndex, generateManifest)
 */

// ---------------------------------------------------------------------------
// Task 1: ID Generation
// ---------------------------------------------------------------------------

/**
 * Internal state: per-minute sequence counter (a-z).
 * Resets to 'a' (index 0) whenever the minute key changes.
 */
let _seqState = { key: '', index: 0 };

/**
 * Exposed for tests only — resets the sequence counter.
 */
export function _resetSequenceForTest() {
  _seqState = { key: '', index: 0 };
}

/**
 * Returns a padded UTC date/time string.
 * @param {Date} now
 * @returns {{ datePart: string, timePart: string, minuteKey: string }}
 */
function _utcParts(now) {
  const yyyy = now.getUTCFullYear().toString();
  const MM = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const HH = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return {
    datePart: `${yyyy}${MM}${dd}`,
    timePart: `${HH}${mm}`,
    minuteKey: `${yyyy}${MM}${dd}${HH}${mm}`,
  };
}

/**
 * Generates a unique entry ID in YYYYMMDD-HHMM-<sessionShort><seq> format.
 * Uses UTC time. Tracks a per-minute sequence counter (a-z).
 *
 * @param {string} sessionShort — 2-char session identifier
 * @returns {string}
 */
export function generateEntryId(sessionShort) {
  const now = new Date();
  const { datePart, timePart, minuteKey } = _utcParts(now);

  if (_seqState.key !== minuteKey) {
    _seqState = { key: minuteKey, index: 0 };
  }

  const seq = String.fromCharCode(97 + (_seqState.index % 26)); // 'a'–'z'
  _seqState.index += 1;

  return `${datePart}-${timePart}-${sessionShort}${seq}`;
}

/**
 * Generates a migration ID in <YYYYMMDD>-0000-mig<NN> format.
 * Date precedence: entryDate → fallbackDate → today (UTC).
 *
 * @param {string|null} entryDate    — ISO date string 'YYYY-MM-DD' or null
 * @param {number}      seq          — sequence number (zero-padded to 2 digits)
 * @param {string|null} fallbackDate — ISO date string 'YYYY-MM-DD' or null
 * @returns {string}
 */
export function generateMigrationId(entryDate, seq, fallbackDate) {
  let dateStr;
  if (entryDate) {
    dateStr = entryDate.replace(/-/g, '');
  } else if (fallbackDate) {
    dateStr = fallbackDate.replace(/-/g, '');
  } else {
    const today = new Date();
    const { datePart } = _utcParts(today);
    dateStr = datePart;
  }

  const nn = String(seq).padStart(2, '0');
  return `${dateStr}-0000-mig${nn}`;
}

// ---------------------------------------------------------------------------
// Task 2: Entry Parsing
// ---------------------------------------------------------------------------

/**
 * Splits append-only files (journal, decisions, inbox) on blank-line-separated
 * blocks that appear after the `<!-- APPEND-ONLY below` marker.
 * Skips blocks that already have `<!-- id:` markers.
 *
 * @param {string} content
 * @returns {Array<{ text: string, date: string|null }>}
 */
export function parseAppendOnlyEntries(content) {
  // Find the APPEND-ONLY marker
  const markerMatch = content.match(/<!--\s*APPEND-ONLY\b[^>]*-->/);
  if (!markerMatch) return [];

  const afterMarker = content.slice(markerMatch.index + markerMatch[0].length);

  // Split on one or more blank lines
  const rawBlocks = afterMarker.split(/\n{2,}/);

  const entries = [];
  for (const raw of rawBlocks) {
    const block = raw.trim();
    if (!block) continue;
    // Skip blocks that already have an id
    if (block.includes('<!-- id:')) continue;

    // Extract date from **YYYY-MM-DD** pattern
    const dateMatch = block.match(/\*\*(\d{4}-\d{2}-\d{2})\*\*/);
    entries.push({
      text: block,
      date: dateMatch ? dateMatch[1] : null,
    });
  }

  return entries;
}

/**
 * Splits profile/knowledge files on top-level bullets within `## Section` headers.
 * Each top-level bullet + its indented children = one entry.
 * Returns `[{ text, section, entity, lineIndex }]`.
 * Entity extracted from `**bold text**`, normalized to lowercase-hyphenated.
 * Skips entries with existing `<!-- id:` markers.
 *
 * @param {string} content
 * @returns {Array<{ text: string, section: string, entity: string|null, lineIndex: number }>}
 */
export function parseReferenceEntries(content) {
  const lines = content.split('\n');
  const entries = [];

  let currentSection = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect ## section headers (exactly two #, not ###)
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      i++;
      continue;
    }

    // Skip non-section heading lines and lines without a section context
    if (!currentSection) {
      i++;
      continue;
    }

    // Detect top-level bullet (starts with "- ")
    if (/^- /.test(line)) {
      const startLineIndex = i;
      const bulletLines = [line];
      i++;

      // Consume indented child lines
      while (i < lines.length && /^[ \t]+/.test(lines[i]) && lines[i].trim() !== '') {
        bulletLines.push(lines[i]);
        i++;
      }

      const text = bulletLines.join('\n');

      // Skip if already has an id marker
      if (text.includes('<!-- id:')) continue;

      // Extract entity from first **bold** occurrence
      const boldMatch = text.match(/\*\*([^*]+)\*\*/);
      let entity = null;
      if (boldMatch) {
        // Normalize: strip trailing colon, lowercase, replace spaces with hyphens
        entity = boldMatch[1]
          .replace(/:$/, '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '-');
      }

      entries.push({ text, section: currentSection, entity, lineIndex: startLineIndex });
      continue;
    }

    i++;
  }

  return entries;
}

/**
 * Splits tasks.md on checkbox lines (`- [ ]` or `- [x]`) within `## Section` headers.
 * Returns `[{ text, section, lineIndex }]`.
 * Skips entries with existing IDs.
 *
 * @param {string} content
 * @returns {Array<{ text: string, section: string, lineIndex: number }>}
 */
export function parseTaskEntries(content) {
  const lines = content.split('\n');
  const entries = [];

  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (!currentSection) continue;

    // Match checkbox lines
    if (/^- \[[ x]\]/.test(line)) {
      // Skip if already has an id marker
      if (line.includes('<!-- id:')) continue;

      entries.push({ text: line, section: currentSection, lineIndex: i });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Task 3: ID Injection
// ---------------------------------------------------------------------------

/**
 * Appends ` <!-- id:<id> -->` to a line (for list items).
 *
 * @param {string} line
 * @param {string} id
 * @returns {string}
 */
export function injectIdIntoLine(line, id) {
  return `${line} <!-- id:${id} -->`;
}

/**
 * Prepends `<!-- id:<id> -->\n` before a block (for append-only entries).
 *
 * @param {string} block
 * @param {string} id
 * @returns {string}
 */
export function injectIdBeforeBlock(block, id) {
  return `<!-- id:${id} -->\n${block}`;
}

/**
 * Takes file content and array of `{ lineIndex, id, type }` assignments.
 * Processes in reverse line-index order so indexes stay valid.
 * type 'inline' — appends id comment to the line.
 * type 'block'  — inserts a new comment line before the line.
 *
 * @param {string} content
 * @param {Array<{ lineIndex: number, id: string, type: 'inline'|'block' }>} assignments
 * @returns {string}
 */
export function injectIdsIntoFile(content, assignments) {
  if (assignments.length === 0) return content;

  const lines = content.split('\n');

  // Sort descending by lineIndex so earlier insertions don't shift later ones
  const sorted = [...assignments].sort((a, b) => b.lineIndex - a.lineIndex);

  for (const { lineIndex, id, type } of sorted) {
    if (type === 'inline') {
      lines[lineIndex] = injectIdIntoLine(lines[lineIndex], id);
    } else {
      // 'block': insert a new line before lineIndex
      lines.splice(lineIndex, 0, `<!-- id:${id} -->`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Task 4: Index File I/O
// ---------------------------------------------------------------------------

/**
 * Generates a sidecar index file as markdown.
 *
 * level 'fact'  — groups by section, includes entity; for profile/knowledge.
 * level 'entry' — flat list with summary and tags; for journal/tasks/etc.
 *
 * All entries get `enriched: false`, `domains: []`, `related: []`.
 * Entry-level also gets `tags: []`, `summary: ~`.
 *
 * @param {string} title
 * @param {Array<{ id: string, section?: string, entity?: string, text: string }>} entries
 * @param {'fact'|'entry'} level
 * @returns {string}
 */
export function generateSkeletonIndex(title, entries, level) {
  const lines = [`# ${title}`, ''];

  if (level === 'fact') {
    // Group by section
    const sections = {};
    for (const entry of entries) {
      const sec = entry.section || 'General';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(entry);
    }

    for (const [section, sectionEntries] of Object.entries(sections)) {
      lines.push(`## ${section}`, '');
      for (const entry of sectionEntries) {
        lines.push(`### ${entry.entity || entry.id}`);
        lines.push(`id: ${entry.id}`);
        if (entry.entity) lines.push(`entity: ${entry.entity}`);
        lines.push('enriched: false');
        lines.push('domains: []');
        lines.push('related: []');
        lines.push('');
      }
    }
  } else {
    // entry level — flat list
    lines.push('## Entries', '');
    for (const entry of entries) {
      lines.push(`### ${entry.id}`);
      lines.push(`id: ${entry.id}`);
      lines.push('enriched: false');
      lines.push('summary: ~');
      lines.push('tags: []');
      lines.push('domains: []');
      lines.push('related: []');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generates `manifest.md` from an array of file metadata objects.
 *
 * @param {Array<{
 *   name: string,
 *   path: string,
 *   indexPath: string,
 *   type: string,
 *   entries: number,
 *   domains?: string[],
 *   sections?: string[],
 * }>} files
 * @returns {string}
 */
export function generateManifest(files) {
  const lines = [
    '# Index Manifest',
    '',
    'Generated index manifest for Robin memory files.',
    '',
    '## Files',
    '',
  ];

  for (const file of files) {
    lines.push(`### ${file.name}`);
    lines.push(`path: ${file.path}`);
    lines.push(`indexPath: ${file.indexPath}`);
    lines.push(`type: ${file.type}`);
    lines.push(`entries: ${file.entries}`);
    if (file.domains && file.domains.length > 0) {
      lines.push(`domains: [${file.domains.join(', ')}]`);
    }
    if (file.sections && file.sections.length > 0) {
      lines.push(`sections: [${file.sections.join(', ')}]`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
