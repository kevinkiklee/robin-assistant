// passes/f-sources.js — copy v1 sources/** into v2's user-data/sources/.
//
// Recursive cp -a. Records one _v1_imports row per file so rollback can
// see what was added (though the filesystem copy itself is left in place
// on --rollback; the user can rm -rf manually).

import { BoundQuery } from 'surrealdb';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';

export async function passSources({ srcRoot, destRoot, db, sessionId, report }) {
  const counts = { copied: 0, skipped: 0, errors: 0 };
  const srcDir = join(srcRoot, 'sources');
  if (!existsSync(srcDir)) return { counts };
  const destDir = join(destRoot, 'sources');
  await mkdir(destDir, { recursive: true });
  for await (const filePath of walkAll(srcDir)) {
    const rel = relative(srcRoot, filePath);
    try {
      const dest = join(destRoot, rel);
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
  return { counts };
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
