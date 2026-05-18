// src/jobs/action-trust.js — Theme 2b: ledger emission + decay sweep + consecutive-correction escalation.
import { surql } from 'surrealdb';
import { ERROR_REASONS } from '../../io/mcp/error-reasons.js';

function classOf(tool, action) {
  return `${tool}:${action}`;
}

// Human-readable phrase per (tool, action) class. Used in the prompt_hint
// field of `requires_permission` refusals so the agent can surface a
// short, user-facing sentence instead of the raw class string.
const ACTION_DESCRIPTIONS = Object.freeze({
  'discord_send:send_dm': 'Send a Discord DM',
  'discord_send:send_channel': 'Post in a Discord channel',
  'github_write:create-issue': 'Create a GitHub issue',
  'github_write:comment': 'Post a GitHub comment',
  'github_write:label': 'Apply a GitHub label',
  'github_write:mark-read': 'Mark a GitHub notification read',
  'spotify_write:playlist-add': 'Add a track to a Spotify playlist',
  'spotify_write:queue': 'Queue a Spotify track',
  'spotify_write:skip': 'Skip the current Spotify track',
  'imessage_send:send_dm': 'Send an iMessage',
  'imessage_send:send_group': 'Send a group iMessage',
});

function humanizeClass(actionClass) {
  // Fallback: turn "tool_name:action-name" into "Tool name — action name".
  const [tool, ...rest] = String(actionClass).split(':');
  const action = rest.join(':') || '_default';
  const titled = (s) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${titled(tool)} — ${titled(action).toLowerCase()}`;
}

export function describeAction(actionClass) {
  return ACTION_DESCRIPTIONS[actionClass] ?? humanizeClass(actionClass);
}

// Standard refusal shape for outbound writes blocked by action-trust=ASK.
// Includes a `prompt_hint` agent-facing string so the surfaced question is
// consistent across tools.
export function refuseWithPermission({ tool, action }) {
  const cls = classOf(tool, action);
  return {
    ok: false,
    reason: ERROR_REASONS.REQUIRES_PERMISSION,
    class: cls,
    prompt_hint: `${describeAction(cls)}? (Y/n)`,
  };
}

const DATETIME_FIELDS = ['last_used_at', 'last_state_change_at', 'updated_at'];

function normalizeRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of DATETIME_FIELDS) {
    const v = out[f];
    if (v != null && typeof v.toDate === 'function') {
      out[f] = v.toDate();
    }
  }
  return out;
}

async function emitLedger(db, row) {
  try {
    await db.query(surql`CREATE action_trust_ledger CONTENT ${row}`).collect();
  } catch (e) {
    console.warn(`[action-trust ledger] ${e.message}`);
  }
}

async function readConsecutiveLimit(db) {
  try {
    const [r] = await db
      .query(
        'SELECT VALUE value.consecutive_corrections_to_block FROM runtime:`action_trust.config`',
      )
      .collect();
    return r?.[0] ?? 3;
  } catch {
    return 3;
  }
}

async function readDecayDays(db) {
  try {
    const [r] = await db
      .query('SELECT VALUE value.decay_days FROM runtime:`action_trust.config`')
      .collect();
    return r?.[0] ?? 90;
  } catch {
    return 90;
  }
}

// All db.query() calls below use .collect() so the reactive
// "Anonymous access not allowed" retry in installQueryRetry catches stale-auth
// failures after a WS reconnect. Bare `await db.query(...)` bypasses that
// wrapper.
export async function getActionTrust(db, cls) {
  const [rows] = await db
    .query(surql`SELECT * FROM action_trust WHERE class = ${cls} LIMIT 1`)
    .collect();
  return normalizeRow(rows?.[0] ?? null);
}

export async function listActionTrust(db) {
  const [rows] = await db.query(surql`SELECT * FROM action_trust ORDER BY class ASC`).collect();
  return (rows ?? []).map(normalizeRow);
}

export async function checkActionTrust(db, tool, action) {
  const cls = classOf(tool, action);
  const existing = await getActionTrust(db, cls);
  if (existing) return existing;
  const row = {
    class: cls,
    state: 'ASK',
    set_by: 'default',
    success_count: 0,
    correction_count: 0,
    last_state_change_at: new Date(),
  };
  await db.query(surql`CREATE action_trust CONTENT ${row}`).collect();
  await emitLedger(db, {
    class: cls,
    // old_state omitted (null collides with option<string> in v3)
    new_state: 'ASK',
    kind: 'initial',
    set_by: 'default',
  });
  return await getActionTrust(db, cls);
}

export async function setActionTrust(db, cls, state, set_by, reason) {
  const parts = cls.split(':');
  const tool = parts[0];
  const action = parts.slice(1).join(':') || '_default';
  const old = await getActionTrust(db, cls);
  await checkActionTrust(db, tool, action);
  await db
    .query(
      surql`UPDATE action_trust MERGE ${{
        state,
        set_by,
        last_state_change_at: new Date(),
      }} WHERE class = ${cls}`,
    )
    .collect();
  const actionKind =
    old?.state === state ? 'success' : state === 'AUTO' ? 'manual_promote' : 'manual_demote';
  const ledger = {
    class: cls,
    new_state: state,
    kind: actionKind,
    set_by,
  };
  if (old?.state) ledger.old_state = old.state;
  if (reason) ledger.reason = reason;
  await emitLedger(db, ledger);
}

export async function recordOutcome(db, cls, outcome) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  const patch = { last_used_at: new Date() };
  const oldState = row.state;
  let stateChanged = false;
  if (outcome === 'success') {
    patch.success_count = (row.success_count ?? 0) + 1;
  } else if (outcome === 'correction') {
    patch.correction_count = (row.correction_count ?? 0) + 1;
    if (row.state === 'AUTO') {
      patch.state = 'ASK';
      patch.set_by = 'correction';
      patch.last_state_change_at = new Date();
      stateChanged = true;
    }
  }
  await db.query(surql`UPDATE action_trust MERGE ${patch} WHERE class = ${cls}`).collect();

  await emitLedger(db, {
    class: cls,
    old_state: oldState,
    new_state: patch.state ?? oldState,
    kind: outcome,
    set_by: stateChanged ? 'correction_loop' : (row.set_by ?? 'default'),
  });

  // Theme 2b: consecutive-correction escalation
  if (outcome === 'correction') {
    const limit = await readConsecutiveLimit(db);
    const [recent] = await db
      .query(
        surql`SELECT * FROM action_trust_ledger
              WHERE class = ${cls} AND kind IN ['success', 'correction']
              ORDER BY ts DESC LIMIT ${limit}`,
      )
      .collect();
    let consecutive = 0;
    for (const r of recent ?? []) {
      if (r.kind === 'success') break;
      if (r.kind === 'correction') consecutive++;
    }
    if (consecutive >= limit) {
      await db
        .query(
          surql`UPDATE action_trust MERGE ${{
            state: 'DENY',
            set_by: 'correction_loop',
            last_state_change_at: new Date(),
          }} WHERE class = ${cls}`,
        )
        .collect();
      await emitLedger(db, {
        class: cls,
        old_state: patch.state ?? oldState,
        new_state: 'DENY',
        kind: 'auto_block',
        set_by: 'correction_loop',
        reason: `${consecutive} consecutive corrections`,
      });
    }
  }
}

export async function demoteOnCorrection(db, cls) {
  const row = await getActionTrust(db, cls);
  if (!row) return { demoted: false };
  if (row.state !== 'AUTO') {
    await recordOutcome(db, cls, 'correction');
    return { demoted: false };
  }
  await recordOutcome(db, cls, 'correction');
  return { demoted: true, from: 'AUTO' };
}

export async function resetActionTrust(db, cls) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  await db
    .query(
      surql`UPDATE action_trust MERGE ${{
        state: 'ASK',
        set_by: 'default',
        last_state_change_at: new Date(),
      }} WHERE class = ${cls}`,
    )
    .collect();
  await emitLedger(db, {
    class: cls,
    old_state: row.state,
    new_state: 'ASK',
    kind: 'manual_demote',
    set_by: 'default',
    reason: 'reset',
  });
}

// Theme 2b: decay sweep — demote stale AUTO classes to ASK. Heartbeat-invokable.
export async function runActionTrustDecay(db) {
  const decay_days = await readDecayDays(db);
  // Two-pass: NONE check first, then age check. SurrealDB v3 evaluates both
  // sides of OR even when short-circuit would be safe; merge results in JS.
  const cutoff = new Date(Date.now() - decay_days * 86_400_000);
  const [staleA] = await db
    .query(surql`SELECT class FROM action_trust WHERE state = 'AUTO' AND last_used_at IS NONE`)
    .collect();
  const [staleB] = await db
    .query(surql`SELECT class FROM action_trust WHERE state = 'AUTO' AND last_used_at < ${cutoff}`)
    .collect();
  const seen = new Set();
  const stale = [];
  for (const r of [...(staleA ?? []), ...(staleB ?? [])]) {
    if (seen.has(r.class)) continue;
    seen.add(r.class);
    stale.push(r);
  }
  let demoted = 0;
  for (const r of stale) {
    await db
      .query(
        surql`UPDATE action_trust SET state = 'ASK', set_by = 'decay_sweep', last_state_change_at = time::now() WHERE class = ${r.class}`,
      )
      .collect();
    await emitLedger(db, {
      class: r.class,
      old_state: 'AUTO',
      new_state: 'ASK',
      kind: 'decay',
      set_by: 'decay_sweep',
      reason: `unused for ${decay_days}d`,
    });
    demoted++;
  }
  return { demoted };
}
