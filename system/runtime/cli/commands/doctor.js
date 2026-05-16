// `robin doctor` — extended health overview and the operational-invariants
// framework surface.
//
// Dispatcher only. Probe helpers, special command handlers, and the default
// status renderer live in sibling _doctor-*.js modules. The invariants
// runner provides the new --invariants / --emit-runbook / --diff-legacy
// flags.
//
// Flags:
//   --rebaseline             rewrite <robinHome>/manifest.json from current state
//   --purge-stale-sessions   delete runtime_sessions rows whose status='stale'
//   --lint-hooks             list robin-owned hook entries in host settings
//   --health                 structured health probe (delegates to runHealth)
//   --invariants             render the invariants registry status
//   --diff-legacy            compare framework verdict to the legacy pointer probe
//   --emit-runbook           print the auto-generated runbook to stdout
//     +--write               replace the sentinel block in CLAUDE.md in-place
//     +--check               CI mode: exit non-zero on drift
//
// With NO flags: print a one-fact-per-line status overview.

import {
  existsSync,
  readFileSync,
  renameSync as renameSyncFs,
  writeFileSync as writeFileSyncFs,
} from 'node:fs';
import { join } from 'node:path';
import { packageRootDir, paths, pointerExists } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { makeCtx as makeInvariantCtx } from '../../invariants/ctx.js';
import { recordDivergence } from '../../invariants/divergence-log.js';
import { getAllInvariants } from '../../invariants/index.js';
import installPointerPresent from '../../invariants/install.pointer-present.js';
import { isInSync, renderRunbook, replaceSentinelBlock } from '../../invariants/runbook.js';
import { run as runInvariants } from '../../invariants/runner.js';
import { parseArgs } from '../args.js';
import { doLintHooks, doPurgeStaleSessions, doRebaseline } from './_doctor-special-commands.js';
import { doctorData, doStatus } from './_doctor-status.js';

// Re-export for consumers that import { doctorData } from this module.
export { doctorData };

/**
 * `--emit-runbook` family. Writes the generated runbook to stdout (no flags),
 * to a file in-place (--write), or runs a CI drift check (--check).
 */
async function doEmitRunbook(out, err, { write = false, check = false, claudeMdPath } = {}) {
  const body = renderRunbook(await getAllInvariants());
  if (!write && !check) {
    out(body);
    return 0;
  }
  const path = claudeMdPath ?? join(packageRootDir(), 'CLAUDE.md');
  if (!existsSync(path)) {
    err(`CLAUDE.md not found at ${path}`);
    return 4;
  }
  const existing = readFileSync(path, 'utf8');
  if (check) {
    if (isInSync(existing, body)) {
      out('runbook in sync');
      return 0;
    }
    err('runbook drift detected; run `robin doctor --emit-runbook --write` to regenerate.');
    return 1;
  }
  const next = replaceSentinelBlock(existing, body);
  if (next === existing) {
    out('runbook already in sync');
    return 0;
  }
  const tmp = `${path}.tmp`;
  writeFileSyncFs(tmp, next, 'utf8');
  renameSyncFs(tmp, path);
  out(`runbook written to ${path}`);
  return 0;
}

/**
 * `--invariants`: run the doctor trigger across the registry; print a compact
 * status table. Read-only; never repairs.
 */
async function doInvariantsRender(out) {
  const ctx = makeInvariantCtx({ paths, trigger: 'doctor', logFallback: false });
  const report = await runInvariants({
    trigger: 'doctor',
    ctx,
    invariants: await getAllInvariants(),
  });
  let crit = 0;
  let warn = 0;
  let info = 0;
  let ok = 0;
  let skipped = 0;
  for (const r of report.results) {
    if (r.status === 'skipped') {
      skipped++;
      continue;
    }
    if (r.status === 'ok') {
      ok++;
      out(`✓ ${r.name}`);
      continue;
    }
    if (r.level === 'critical') crit++;
    else if (r.level === 'warn') warn++;
    else info++;
    const tag = r.level === 'critical' ? 'X' : '!';
    out(`${tag} ${r.name}  [${r.level}]  ${r.error ?? ''}`);
  }
  out('');
  out(`Summary: ${ok} ok · ${warn} warn · ${crit} critical · ${info} info · ${skipped} skipped`);
  if (crit > 0) return 2;
  if (warn > 0) return 1;
  return 0;
}

/**
 * `--diff-legacy`: compare framework's install.pointer_present verdict against
 * the legacy probe (pointerExists). Append disagreements to the divergence log.
 */
async function doDiffLegacy(out, { logPath = paths.data.divergenceLog() } = {}) {
  const legacyOk = pointerExists();
  const fw = await installPointerPresent.check();
  const agree = (legacyOk === true) === (fw.ok === true);
  out(`legacy pointerExists(): ${legacyOk}`);
  out(`framework install.pointer_present.ok: ${fw.ok}`);
  if (fw.error) out(`framework error: ${fw.error}`);
  if (!agree) {
    out('DIVERGENCE: legacy and framework disagree');
    recordDivergence(logPath, {
      invariant: 'install.pointer_present',
      legacy: { ok: legacyOk },
      framework: { ok: fw.ok, error: fw.error, evidence: fw.evidence },
    });
    out(`  recorded to ${logPath}`);
  } else {
    out('agree');
  }
}

export async function doctor(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));

  const wantRebaseline = args.flags.rebaseline === true;
  const wantPurge = args.flags['purge-stale-sessions'] === true;
  const wantLint = args.flags['lint-hooks'] === true;
  const wantHealth = args.flags.health === true;
  const wantDiffLegacy = args.flags['diff-legacy'] === true;
  const wantEmitRunbook = args.flags['emit-runbook'] === true;
  const wantInvariants = args.flags.invariants === true;

  if (wantHealth) {
    const wantJson = args.flags.json === true;
    const { runHealth } = await import('../health.js');
    const openDb = deps.openDb ?? (async () => connect({ engine: await defaultDbUrl() }));
    const closeDb = deps.closeDb ?? ((d) => close(d));
    const db = await openDb();
    try {
      const result = await runHealth(db, { json: wantJson });
      out(result.output);
      if (typeof process !== 'undefined') process.exitCode = result.exitCode;
    } finally {
      await closeDb(db).catch(() => {});
    }
    return;
  }

  if (wantDiffLegacy) {
    await doDiffLegacy(out, { logPath: deps.divergenceLogPath });
    return;
  }

  if (wantEmitRunbook) {
    const code = await doEmitRunbook(out, err, {
      write: args.flags.write === true,
      check: args.flags.check === true,
      claudeMdPath: deps.claudeMdPath,
    });
    if (typeof process !== 'undefined') process.exitCode = code;
    return;
  }

  if (wantInvariants) {
    const code = await doInvariantsRender(out);
    if (typeof process !== 'undefined') process.exitCode = code;
    return;
  }

  if (!wantRebaseline && !wantPurge && !wantLint) {
    await doStatus(out, deps);
    return;
  }

  if (wantRebaseline) await doRebaseline(out);
  if (wantPurge)
    await doPurgeStaleSessions(out, err, { openDb: deps.openDb, closeDb: deps.closeDb });
  if (wantLint) await doLintHooks(out, { homeDir: deps.homeDir });
}
