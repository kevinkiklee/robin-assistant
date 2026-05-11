import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../../config/data-store.js';
import { isDiaryCsv, parseDiaryCsv } from './csv.js';

function uploadDir() {
  return paths.data.upload();
}

function processedDir() {
  return join(uploadDir(), 'processed');
}

/**
 * Build human-readable content string for a diary row.
 * Format: watched <Name> (<Year>) — <Rating>★[ (rewatch)]
 * Rating section omitted when null.
 */
function buildContent(row) {
  let content = `watched ${row.name} (${row.year})`;
  if (row.rating !== null) {
    content += ` — ${row.rating}★`;
  }
  if (row.rewatch) {
    content += ' (rewatch)';
  }
  return content;
}

export async function sync(ctx) {
  const dir = uploadDir();

  // Ensure upload dir exists (belt-and-suspenders; preflight also creates it).
  mkdirSync(dir, { recursive: true });
  mkdirSync(processedDir(), { recursive: true });

  // Find all letterboxd-*.csv files in the upload dir.
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.match(/^letterboxd-.+\.csv$/i) && !f.startsWith('.'));
  } catch {
    return { count: 0 };
  }

  if (files.length === 0) {
    return { count: 0 };
  }

  const allEvents = [];

  for (const filename of files) {
    const filePath = join(dir, filename);
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (err) {
      ctx.log?.(`letterboxd: failed to read ${filename}: ${err.message}`);
      continue;
    }

    // Check if it's a Diary CSV by inspecting the header line.
    const firstLine = text.split(/\r?\n/)[0] ?? '';
    if (!isDiaryCsv(firstLine)) {
      // Move to processed as .unrecognized + write an error sidecar.
      const dest = join(processedDir(), `${filename}.unrecognized`);
      try {
        renameSync(filePath, dest);
        writeFileSync(
          `${dest}.error.txt`,
          `File "${filename}" was not recognized as a Letterboxd Diary CSV.\nHeader: ${firstLine}\n`,
        );
      } catch (err) {
        ctx.log?.(`letterboxd: failed to move unrecognized file ${filename}: ${err.message}`);
      }
      continue;
    }

    // Parse the diary CSV.
    let rows;
    try {
      rows = parseDiaryCsv(text);
    } catch (err) {
      // Write error sidecar next to original; leave original in place.
      try {
        writeFileSync(`${filePath}.error.txt`, `Failed to parse "${filename}": ${err.message}\n`);
      } catch {
        // ignore sidecar write failure
      }
      ctx.log?.(`letterboxd: parse error in ${filename}: ${err.message}`);
      continue;
    }

    // Build events for each diary row.
    const fileEvents = rows.map((row) => ({
      source: 'letterboxd',
      external_id: `letterboxd:diary:${row.watched_date}:${row.slug}`,
      content: buildContent(row),
      ts: new Date(row.watched_date),
      meta: {
        kind: 'letterboxd_diary',
        name: row.name,
        year: row.year,
        rating: row.rating,
        rewatch: row.rewatch,
        tags: row.tags,
        watched_date: row.watched_date,
        uri: row.uri,
      },
    }));

    allEvents.push(...fileEvents);

    // Move processed file to processed/<filename>.
    const dest = join(processedDir(), filename);
    try {
      renameSync(filePath, dest);
    } catch (err) {
      ctx.log?.(`letterboxd: failed to move ${filename} to processed/: ${err.message}`);
    }
  }

  if (allEvents.length > 0) {
    await ctx.capture(allEvents);
  }

  return { count: allEvents.length };
}
