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
//     +--write               replace the sentinel block in RUNBOOK.md in-place
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
import { readState } from '../../invariants/state.js';
import { parseArgs } from '../args.js';
import { doLintHooks, doPurgeStaleSessions, doRebaseline } from './_doctor-special-commands.js';
import { doctorData, doStatus, renderDoctor } from './_doctor-status.js';

// Re-export for consumers that import { doctorData } from this module.
export { doctorData };

/**
 * `--emit-runbook` family. Writes the generated runbook to stdout (no flags),
 * to a file in-place (--write), or runs a CI drift check (--check).
 */
async function doEmitRunbook(out, err, { write = false, check = false, runbookPath, claudeMdPath } = {}) {
  const body = renderRunbook(await getAllInvariants());
  if (!write && !check) {
    out(body);
    return 0;
  }
  // Backwards compat: accept legacy `claudeMdPath` from tests; default target is
  // now RUNBOOK.md to keep the always-loaded CLAUDE.md lean.
  const path = runbookPath ?? claudeMdPath ?? join(packageRootDir(), 'RUNBOOK.md');
  if (!existsSync(path)) {
    err(`runbook target not found at ${path}`);
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
 * `--invariants`: run the doctor trigger across the registry; render
 * realm-grouped output with inline remediation. Read-only; never repairs.
 *
 * Maps the runner's report shape onto the renderer contract:
 *   runner: { name, status: 'ok'|'fail'|'skipped'|'error', level, error, ... }
 *   render: { name, surface, status: 'ok'|'warn'|'fail', error?, remediation? }
 *
 * The level→status mapping treats `warn`/`info` invariants as `warn` and
 * `critical` invariants as `fail`; skipped/errored results pass through as
 * `ok`/`fail` so the renderer doesn't count them in the wrong bucket.
 */
async function doInvariantsRender(out, { verbose = false, colors = false } = {}) {
  const ctx = makeInvariantCtx({ paths, trigger: 'doctor', logFallback: false });
  const invariants = await getAllInvariants();
  const byName = new Map(invariants.map((i) => [i.name, i]));
  const report = await runInvariants({ trigger: 'doctor', ctx, invariants });

  // When verbose, attach last-passed provenance from invariants-state.json.
  // Best-effort: a missing/corrupt state file returns emptyState() and every
  // result simply gets `lastPassedTs: undefined` → rendered as `never`.
  let stateByName = new Map();
  if (verbose) {
    try {
      const state = readState(paths.data.invariantsState());
      stateByName = new Map(Object.entries(state.invariants ?? {}));
    } catch (e) {
      out(`  (warning: failed to read invariants-state.json: ${e.message})`);
    }
  }

  const results = [];
  for (const r of report.results) {
    if (r.status === 'skipped') continue;
    const inv = byName.get(r.name);
    const surface = inv?.surface ?? 'other';
    const remediation = inv?.remediation;
    let status;
    if (r.status === 'ok') {
      status = 'ok';
    } else if (r.status === 'error' || r.level === 'critical') {
      status = 'fail';
    } else {
      status = 'warn';
    }
    const entry = stateByName.get(r.name);
    const lastPassedTs = entry?.last_pass_at
      ? new Date(entry.last_pass_at).toISOString()
      : undefined;
    results.push({ name: r.name, surface, status, error: r.error, remediation, lastPassedTs });
  }

  const ts = new Date().toISOString();
  const text = renderDoctor({ results, ts, verbose, colors });
  out(text);

  const exitMatch = /Exit (\d+)\./.exec(text);
  return exitMatch ? Number(exitMatch[1]) : 0;
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
  const verbose = args.flags.verbose === true;
  // Color is on only when stdout is a real TTY AND NO_COLOR is unset AND we're
  // not emitting JSON. Tests run without a TTY so `colors` collapses to false
  // by default — `colors:true` is asserted explicitly via the renderDoctor
  // tests, not by spawning this CLI.
  const colors =
    typeof process !== 'undefined' &&
    process.stdout?.isTTY === true &&
    !process.env.NO_COLOR &&
    args.flags.json !== true;

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
      runbookPath: deps.runbookPath,
      claudeMdPath: deps.claudeMdPath,
    });
    if (typeof process !== 'undefined') process.exitCode = code;
    return;
  }

  if (wantInvariants) {
    const code = await doInvariantsRender(out, { verbose, colors });
    if (typeof process !== 'undefined') process.exitCode = code;
    return;
  }

  if (!wantRebaseline && !wantPurge && !wantLint) {
    // Default surface keeps the host-status overview (ROBIN_HOME, daemon,
    // engine, supervisor, biographer log) and then appends the realm-grouped
    // invariant render with inline remediation. We deliberately do NOT mutate
    // `process.exitCode` from the default path — tests call `doctor()` in
    // process and a poisoned exitCode bleeds across test files. Callers that
    // need exit semantics (CI, scripts) should use `--invariants` (which sets
    // exitCode) or pipe the output through `grep -q 'Exit 0\.' ` and act on
    // the grep result.
    await doStatus(out, deps);
    out('');
    out('── Invariants ────────────────────────────');
    await doInvariantsRender(out, { verbose, colors });
    return;
  }

  if (wantRebaseline) await doRebaseline(out);
  if (wantPurge)
    await doPurgeStaleSessions(out, err, { openDb: deps.openDb, closeDb: deps.closeDb });
  if (wantLint) await doLintHooks(out, { homeDir: deps.homeDir });
}
