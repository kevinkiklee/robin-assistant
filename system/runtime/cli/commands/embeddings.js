// src/cli/commands/embeddings.js — `robin embeddings <subcommand>`.
// Spec §6 (Embedder swap protocol) + §15 (File-by-file change plan).
//
// Subcommands:
//   list                                — show active/read profile, history,
//                                          available_profiles, existing
//                                          embeddings_* tables + row counts.
//   prepare <profile>                   — DDL the three per-surface HNSW tables.
//   backfill <profile>                  — resumable batch embed into a profile.
//   activate <profile>                  — atomic flip of active_profile.
//   dual-read --on|--off [--profile <p>] — diverge/converge read_profile.
//   drop <profile> [--force]            — drop the three tables (refuses if
//                                          active or has rows).
//
// Mutating ops route through the daemon (single-writer property). The read-only
// `list` connects to the DB directly.

import readline from 'node:readline/promises';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { tableNameSafeProfile } from '../../../data/embed/profile-router.js';
import { daemonRequest as defaultRequest } from '../daemon-request.js';

const VALID_PROFILE_RX = /^[a-z0-9-]+$/;
const USAGE = [
  'usage: robin embeddings <list|prepare|backfill|activate|dual-read|drop> [args]',
  '  list',
  '  prepare <profile>',
  '  backfill <profile>',
  '  activate <profile>',
  '  dual-read --on|--off [--profile <profile>]',
  '  drop <profile> [--force]',
].join('\n');

export async function embeddings(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    out(USAGE);
    if (!sub) process.exitCode = 1;
    return;
  }

  try {
    if (sub === 'list') return await listCmd({ out, err, deps });
    if (sub === 'prepare') return await prepareCmd(rest, { out, err, request });
    if (sub === 'backfill') return await backfillCmd(rest, { out, err, request });
    if (sub === 'activate') return await activateCmd(rest, { out, err, request });
    if (sub === 'dual-read') return await dualReadCmd(rest, { out, err, request });
    if (sub === 'drop') return await dropCmd(rest, { out, err, request, deps });
    err(`unknown embeddings subcommand: ${sub}`);
    err(USAGE);
    process.exitCode = 1;
  } catch (e) {
    err(`embeddings ${sub}: ${e.message}`);
    process.exitCode = 1;
  }
}

function validateProfile(profile) {
  if (!profile) throw new Error('profile required');
  if (!VALID_PROFILE_RX.test(profile)) {
    throw new Error(`invalid profile name: ${profile} (must match /^[a-z0-9-]+$/)`);
  }
}

// ----------------------------------------------------------------------------
// list — read-only; connects directly. Safe to run while daemon is up because
// SurrealDB embedded engine allows concurrent reads from CLI alongside the
// daemon (read-only path); falls back to error if a process lock blocks.
// ----------------------------------------------------------------------------

async function listCmd({ out, err, deps }) {
  const ownsDb = !deps.db;
  const db = deps.db ?? (await connect({ engine: await defaultDbUrl() }));
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:embedder').collect();
    const value = rows?.[0] ?? null;
    if (!value) {
      out('runtime:embedder not configured. Run `robin install` first.');
    } else {
      out(`active_profile: ${value.active_profile ?? '(unset)'}`);
      out(`read_profile:   ${value.read_profile ?? value.active_profile ?? '(unset)'}`);
      const avail = value.available_profiles ?? [];
      out(`available_profiles: ${avail.length ? avail.join(', ') : '(none)'}`);
      const history = value.history ?? [];
      if (history.length) {
        out('history:');
        for (const h of history) {
          const deactivated = h.deactivated_at ? ` → ${h.deactivated_at}` : '';
          const reason = h.reason ? ` (${h.reason})` : '';
          out(`  ${h.profile}: ${h.activated_at}${deactivated}${reason}`);
        }
      }
    }

    const [info] = await db.query('INFO FOR DB').collect();
    const tables = Object.keys(info?.tables ?? {}).filter((t) => t.startsWith('embeddings_'));
    if (!tables.length) {
      out('embeddings tables: (none)');
      return;
    }
    out('embeddings tables:');
    for (const t of tables.sort()) {
      try {
        const [counts] = await db.query(`SELECT count() AS n FROM ${t} GROUP ALL`).collect();
        const n = counts?.[0]?.n ?? 0;
        out(`  ${t}: ${n} row${n === 1 ? '' : 's'}`);
      } catch (e) {
        err(`  ${t}: count failed (${e.message})`);
      }
    }
  } finally {
    if (ownsDb) await close(db);
  }
}

// ----------------------------------------------------------------------------
// prepare — create per-surface HNSW tables for a new profile + add to
// available_profiles. Refuses if any of the three tables already exist.
// ----------------------------------------------------------------------------

async function prepareCmd(argv, { out, err, request }) {
  const profile = argv[0];
  validateProfile(profile);
  const result = await request('/internal/embeddings/op', { op: 'prepare', profile });
  if (result?.ok) {
    out(`prepared ${profile}: ${result.tables.join(', ')}`);
    return;
  }
  err(`prepare failed: ${result?.reason ?? 'unknown'}`);
  process.exitCode = 1;
}

// ----------------------------------------------------------------------------
// backfill — resumable batch embed. Long-running; daemon owns the work.
// ----------------------------------------------------------------------------

async function backfillCmd(argv, { out, err, request }) {
  const profile = argv[0];
  validateProfile(profile);
  out(`backfill ${profile}: starting (resumable; safe to interrupt)`);
  const result = await request('/internal/embeddings/op', { op: 'backfill', profile });
  if (result?.ok) {
    out(`backfill ${profile}: ${result.summary}`);
    return;
  }
  err(`backfill failed: ${result?.reason ?? 'unknown'}`);
  process.exitCode = 1;
}

// ----------------------------------------------------------------------------
// activate — atomic flip. Refuses if the profile's three tables don't exist.
// ----------------------------------------------------------------------------

async function activateCmd(argv, { out, err, request }) {
  // First positional that isn't --force is the profile name.
  const force = argv.includes('--force');
  const profile = argv.filter((a) => a !== '--force')[0];
  validateProfile(profile);
  const result = await request('/internal/embeddings/op', { op: 'activate', profile, force });
  if (result?.ok) {
    out(`activated ${profile} (read_profile also set to ${profile})`);
    return;
  }
  err(`activate failed: ${result?.reason ?? 'unknown'}`);
  if (result?.gaps?.length) {
    err('backfill gaps:');
    for (const g of result.gaps) {
      if (g.error) err(`  • ${g.surface}: ${g.error}`);
      else err(`  • ${g.surface}: ${g.target_count}/${g.source_count} (${g.missing} missing)`);
    }
  }
  if (result?.hint) err(`hint: ${result.hint}`);
  process.exitCode = 1;
}

// ----------------------------------------------------------------------------
// dual-read --on|--off [--profile <p>]
//   --on  : set read_profile = --profile (or the only non-active available)
//   --off : set read_profile = active_profile (converge)
// ----------------------------------------------------------------------------

async function dualReadCmd(argv, { out, err, request }) {
  const on = argv.includes('--on');
  const off = argv.includes('--off');
  if (on === off) {
    err('dual-read: pass exactly one of --on or --off');
    process.exitCode = 1;
    return;
  }
  let profile = null;
  const pIdx = argv.indexOf('--profile');
  if (pIdx >= 0) {
    profile = argv[pIdx + 1];
    validateProfile(profile);
  }
  const result = await request('/internal/embeddings/op', {
    op: 'dual-read',
    state: on ? 'on' : 'off',
    profile,
  });
  if (result?.ok) {
    out(`read_profile = ${result.read_profile} (active = ${result.active_profile})`);
    return;
  }
  err(`dual-read failed: ${result?.reason ?? 'unknown'}`);
  process.exitCode = 1;
}

// ----------------------------------------------------------------------------
// drop — DROP three tables for a profile. Refuses if profile is active or has
// rows. Prompts unless --force.
// ----------------------------------------------------------------------------

async function dropCmd(argv, { out, err, request, deps }) {
  const profile = argv[0];
  validateProfile(profile);
  const force = argv.includes('--force');
  if (!force) {
    const rl =
      deps.readlineFactory?.() ??
      readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = await rl.question(`drop embeddings_${tableNameSafeProfile(profile)}_* ? [y/N] `);
      if (!/^y(es)?$/i.test(ans.trim())) {
        out('aborted');
        return;
      }
    } finally {
      if (typeof rl.close === 'function') rl.close();
    }
  }
  const result = await request('/internal/embeddings/op', { op: 'drop', profile });
  if (result?.ok) {
    out(`dropped ${result.tables.join(', ')}`);
    return;
  }
  err(`drop failed: ${result?.reason ?? 'unknown'}`);
  process.exitCode = 1;
}
