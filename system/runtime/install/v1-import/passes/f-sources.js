// passes/f-sources.js — copy v1 sources/** into v2's user-data/sources/.
//
// Recursive cp -a. Records one _v1_imports row per file so rollback can
// see what was added (though the filesystem copy itself is left in place
// on --rollback; the user can rm -rf manually).

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { BoundQuery } from 'surrealdb';
import { paths } from '../../../../config/data-store.js';
import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';

export async function passSources({ srcRoot, db, sessionId, report }) {
  const counts = { copied: 0, skipped: 0, errors: 0 };

  // sources/ → <home>/sources/ (recursive, all files). Destination is
  // computed via paths.data.sources() so we ride the faculty-aligned v2
  // layout rather than encoding the literal directory name here.
  await copyTree({
    srcDir: join(srcRoot, 'sources'),
    destDir: paths.data.sources(),
    db,
    sessionId,
    report,
    counts,
    kind: 'sources',
  });

  // artifacts/ → <home>/artifacts/ (markdown only — live working docs
  // like packing lists / trip plans that aren't derivable from memory/)
  await copyTree({
    srcDir: join(srcRoot, 'artifacts'),
    destDir: paths.data.artifacts(),
    db,
    sessionId,
    report,
    counts,
    filter: (name) => name.endsWith('.md'),
    kind: 'artifacts',
  });

  return { counts };
}

async function copyTree({ srcDir, destDir, db, sessionId, report, counts, filter, kind }) {
  if (!existsSync(srcDir)) return;
  for await (const filePath of walkAll(srcDir)) {
    if (filter && !filter(filePath)) continue;
    // Path of this file relative to its v1 source root (e.g. "sources/foo.md").
    // Used purely for stable hashing + ledger provenance — the destination is
    // computed below from `destDir` so the v2 layout owns the target path.
    const rel = join(kind, relative(srcDir, filePath));
    try {
      const dest = join(destDir, relative(srcDir, filePath));
      const st = await stat(filePath);
      const hash = sha256(`${rel}\n${st.size}\n${st.mtime.toISOString()}`);
      if (await hashExists(db, hash)) {
        counts.skipped++;
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(filePath, dest);
      await db
        .query(
          new BoundQuery(
            'CREATE _v1_imports SET source_path = $sp, content_hash = $h, target = $t, kind = $k, import_session = $s',
            { sp: rel, h: hash, t: dest, k: 'source_file', s: sessionId },
          ),
        )
        .collect();
      counts.copied++;
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'F', file: rel, message: e.message });
    }
  }
}

async function* walkAll(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkAll(p);
    else if (e.isFile()) yield p;
  }
}
