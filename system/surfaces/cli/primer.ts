import { buildPrimer, writePrimerFile } from '../../brain/cognition/primer.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

export interface PrimerCliOptions {
  /** Materialize the primer to a file instead of printing it. */
  write?: boolean;
  /** Override the output path for --write. */
  path?: string;
}

/**
 * `robin primer` — print the session-start primer to stdout (debug/inspection). The real
 * session-start path builds this on demand via the daemon's /hooks/session_start route; this
 * command exists only to inspect what that primer would contain. `--write` materializes it.
 */
export function runPrimer(opts: PrimerCliOptions = {}): void {
  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  try {
    if (opts.write) {
      const r = writePrimerFile(db, opts.path ? { path: opts.path } : {});
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.log(`Wrote ${r.bytes} bytes to ${r.path}`);
      return;
    }
    const primer = buildPrimer(db);
    // biome-ignore lint/suspicious/noConsole: CLI output — stdout is the payload
    console.log(primer);
  } finally {
    closeDb(db);
  }
}
