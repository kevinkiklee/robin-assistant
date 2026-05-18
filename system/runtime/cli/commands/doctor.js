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
async function doEmitRunbook(
  out,
  err,
  { write = false, check = false, runbookPath, claudeMdPath } = {},
) {
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

// Two independent gates on falling back to the daemon's state file:
//  - state file itself must be fresh (heartbeat tick writes every ~60s, so a
//    >10m gap means the daemon is wedged or stopped — don't claim ok from it)
//  - per-invariant `last_pass_at` must be within 2× that invariant's heartbeat
//    cadence (60s for db.authenticated, 1h for db.embedder_profile_match, etc.)
const STATE_FILE_STALE_MS = 10 * 60 * 1000;
const DEFAULT_INVARIANT_CADENCE_MS = 15 * 60 * 1000;

/**
 * When an invariant returns `no_db_handle` (the doctor process has no DB
 * handle by design), check whether the daemon — which evaluates the same
 * invariants on its heartbeat with a real DB — recently passed it. Returns
 * `{ ageMs }` if the daemon-evaluated verdict can stand in, otherwise null.
 *
 * Pure / no I/O — caller passes the already-loaded state. This is the unit
 * under test in `doctor-invariants-state-fallback.test.js`.
 */
export function maybePromoteWithDaemonState({
  result,
  invariant,
  state,
  now = Date.now(),
  fileStaleMs = STATE_FILE_STALE_MS,
  defaultCadenceMs = DEFAULT_INVARIANT_CADENCE_MS,
} = {}) {
  if (!result || result.error !== 'no_db_handle') return null;
  if (!state?.generated_at) return null;
  const generatedAt = Date.parse(state.generated_at);
  if (!Number.isFinite(generatedAt)) return null;
  if (now - generatedAt > fileStaleMs) return null;
  const entry = state.invariants?.[result.name];
  if (!entry?.last_pass_at) return null;
  if (entry.last_result_summary?.ok !== true) return null;
  const cadenceMs = invariant?.runWhen?.heartbeat?.cooldownMs ?? defaultCadenceMs;
  const ageMs = now - entry.last_pass_at;
  if (ageMs < 0) return null;
  if (ageMs > 2 * cadenceMs) return null;
  return { ageMs };
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
 *
 * Daemon-state fallback: invariants that touch the DB return `no_db_handle`
 * when invoked from the doctor process (which is probe-only by design — see
 * makeInvariantCtx above, no `db`/`dbFactory`). For those, look up the
 * daemon-written verdict in invariants-state.json and promote to ok when
 * the daemon recently confirmed health.
 */
async function doInvariantsRender(out, { verbose = false, colors = false } = {}) {
  const ctx = makeInvariantCtx({ paths, trigger: 'doctor', logFallback: false });
  const invariants = await getAllInvariants();
  const byName = new Map(invariants.map((i) => [i.name, i]));
  const report = await runInvariants({ trigger: 'doctor', ctx, invariants });

  // Always read invariants-state.json — it's the only signal we have for
  // DB-touching invariants when ctx.db is null, and it's also the source of
  // last_passed provenance for verbose mode. Best-effort: missing/corrupt
  // returns emptyState() so every lookup just yields undefined.
  let state = { invariants: {}, generated_at: null };
  try {
    state = readState(paths.data.invariantsState());
  } catch (e) {
    if (verbose) out(`  (warning: failed to read invariants-state.json: ${e.message})`);
  }
  const stateByName = new Map(Object.entries(state.invariants ?? {}));

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
    let daemonEvaluatedAgoMs;
    const promote = maybePromoteWithDaemonState({ result: r, invariant: inv, state });
    if (promote) {
      status = 'ok';
      daemonEvaluatedAgoMs = promote.ageMs;
    }
    results.push({
      name: r.name,
      surface,
      status,
      error: r.error,
      remediation,
      lastPassedTs,
      daemonEvaluatedAgoMs,
    });
  }

  const ts = new Date().toISOString();
  const text = renderDoctor({ results, ts, verbose, colors });
  out(text);

  const exitMatch = /Exit (\d+)\./.exec(text);
  return exitMatch ? Number(exitMatch[1]) : 0;
}

/**
 * `--repair=<name> [--apply]`: run one invariant's `repair()` function. Without
 * `--apply`, runs in dry-run mode (repair receives `ctx.dryRun=true`, doesn't
 * commit state). With `--apply`, runs for real and persists the outcome to
 * invariants-state.json.
 *
 * Invariants with check() but no repair() return an explicit message. Db-
 * touching repairs return `no_db_handle` because doctor is probe-only by design
 * (see makeInvariantCtx above) — those repairs need the daemon to run them.
 */
async function doRepair(out, { name, apply = false } = {}) {
  const invariants = await getAllInvariants();
  const inv = invariants.find((i) => i.name === name);
  if (!inv) {
    out(`unknown invariant: ${name}`);
    out(`available: ${invariants.map((i) => i.name).join(', ')}`);
    return 2;
  }
  if (typeof inv.repair !== 'function') {
    out(`${name}: no repair() defined — check-only invariant`);
    return 1;
  }
  const ctx = makeInvariantCtx({ paths, trigger: 'doctor', logFallback: false });
  const report = await runInvariants({
    trigger: 'doctor',
    ctx,
    invariants: [inv],
    name,
    repair: true,
    apply,
    statePath: paths.data.invariantsState(),
    lockDir: paths.data.invariantsLocks(),
  });
  const result = report.results[0];
  if (!result) {
    out(`runner returned no result for ${name}`);
    return 1;
  }
  const mode = apply ? 'apply' : 'dry-run';
  out(`Invariant: ${name} (${mode})`);
  out(`  check: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
  if (result.repair) {
    out(`  repair: ${JSON.stringify(result.repair)}`);
    if (!apply && result.repair.action !== 'nothing_to_clean') {
      out('  (dry-run — re-run with --apply to commit)');
    }
  } else if (result.status === 'ok') {
    out('  repair: skipped (check already ok)');
  } else {
    out('  repair: not_run');
  }
  // Success = check ok OR repair successfully committed.
  if (result.status === 'ok') return 0;
  if (apply && result.repair?.repaired) return 0;
  return 1;
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
  // `--repair=<invariant-name>`: parseArgs returns the value as a string;
  // when bare `--repair` is passed it returns `true`, which is invalid here.
  const wantRepair =
    typeof args.flags.repair === 'string' && args.flags.repair.length > 0
      ? args.flags.repair
      : null;
  const wantApply = args.flags.apply === true;
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

  if (wantRepair) {
    const code = await doRepair(out, { name: wantRepair, apply: wantApply });
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
