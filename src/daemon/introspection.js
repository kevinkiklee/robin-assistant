// Daemon-boot introspection. Compares the live filesystem against the
// baseline at <robinHome>/manifest.json (written by `robin install`) and
// persists the result to runtime_introspection_state for SessionStart hooks
// to read without recomputing.
//
// Findings shape:
//   { kind: 'hash_drift'|'mode_drift'|'missing_file'|'supervisor_drift',
//     path, expected, actual }
//
// If no baseline exists, returns ok=true with a single 'no_baseline' finding
// and baselined=false. The daemon should not block on this; surface a hint
// to run `robin install`.

import { surql } from 'surrealdb';
import { computeManifest, readManifest } from '../install/manifest.js';

function diffFiles(expectedFiles, actualFiles) {
  const findings = [];
  const actualByPath = new Map(actualFiles.map((f) => [f.path, f]));
  for (const exp of expectedFiles) {
    const act = actualByPath.get(exp.path);
    if (!act) {
      findings.push({
        kind: 'missing_file',
        path: exp.path,
        expected: exp.sha256,
        actual: null,
      });
      continue;
    }
    if (act.sha256 !== exp.sha256) {
      findings.push({
        kind: 'hash_drift',
        path: exp.path,
        expected: exp.sha256,
        actual: act.sha256,
      });
    }
  }
  return findings;
}

function diffPerms(expected, actual) {
  const findings = [];
  for (const key of ['secrets_env_mode', 'db_dir_mode']) {
    const exp = expected?.[key] ?? null;
    const act = actual?.[key] ?? null;
    if (exp !== act) {
      findings.push({
        kind: 'mode_drift',
        path: key,
        expected: exp,
        actual: act,
      });
    }
  }
  return findings;
}

function diffSupervisor(expected, actual) {
  // Both sides may be undefined when callers pass {includeSupervisor:false}.
  if (!expected && !actual) return [];
  const expHash = expected?.sha256 ?? null;
  const actHash = actual?.sha256 ?? null;
  const expPath = expected?.path ?? null;
  const actPath = actual?.path ?? null;
  if (expHash !== actHash || expPath !== actPath) {
    return [
      {
        kind: 'supervisor_drift',
        path: expPath ?? actPath ?? null,
        expected: expHash,
        actual: actHash,
      },
    ];
  }
  return [];
}

async function persistIntrospectionState(db, { ok, findings }) {
  // runtime_introspection_state is a singleton keyed by 'current'. UPSERT
  // replaces the row each boot. The field 'checked_at' is set explicitly so
  // callers get a deterministic timestamp; the schema also defaults it to
  // time::now().
  await db
    .query(
      surql`UPSERT type::record('runtime_introspection_state', 'current') CONTENT {
        checked_at: time::now(),
        ok: ${ok},
        findings: ${findings}
      }`,
    )
    .collect();
}

export async function runIntrospection(db, opts = {}) {
  const baseline = await readManifest();
  if (!baseline) {
    const findings = [
      {
        kind: 'no_baseline',
        detail: 'no manifest.json — run `robin install` to write baseline',
      },
    ];
    // We still record the boot-time state so SessionStart can surface it.
    await persistIntrospectionState(db, { ok: true, findings });
    return { ok: true, findings, baselined: false };
  }

  const includeSupervisor =
    opts.includeSupervisor !== undefined
      ? opts.includeSupervisor
      : baseline.supervisor !== undefined;
  const actual = await computeManifest({ includeSupervisor });

  const findings = [
    ...diffFiles(baseline.files ?? [], actual.files ?? []),
    ...diffPerms(baseline.perms, actual.perms),
    ...diffSupervisor(baseline.supervisor, actual.supervisor),
  ];

  const ok = findings.length === 0;
  await persistIntrospectionState(db, { ok, findings });
  return { ok, findings, baselined: true };
}

export async function readLastIntrospection(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime_introspection_state', 'current')`)
    .collect();
  if (!rows || rows.length === 0) return null;
  return rows[0];
}
