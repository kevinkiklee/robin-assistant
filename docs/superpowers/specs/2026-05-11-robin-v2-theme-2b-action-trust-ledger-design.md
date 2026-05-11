# Robin v2 — Theme 2b: Action-trust as ledger (mechanism shift from roadmap)

**Status:** Design (working draft; impl waits for `feat/surrealdb-improvements` merge)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 2b)
**Depends on:** `2026-05-11-surrealdb-improvements-design.md` (engine swap; nothing structural)

## Mechanism note vs roadmap

The roadmap described Theme 2b as "action-trust as a graph — flat `action_trust` table dissolves into trust edges (`endorses`, `vouches_for`, `dispatched_by`) so trust composes, decays, and is explainable."

After examining the actual code (`src/jobs/action-trust.js`), the goals (compose, decay, explain) are right but the mechanism (edges) is wrong:

- `action_trust` is a hot-path lookup (called before every potentially-mutating tool call). Edge traversal is slower than direct table lookup; no benefit.
- "Trust between actions" rarely composes — silent transfer of trust from `gmail_send` to `gmail_send_draft` would be a security/UX hazard. Composition should be explicit, not implicit.
- The high-value gaps are **audit history**, **time-decay**, and **consecutive-failure escalation** — all temporal, not relational.

The right mechanism is the same ledger pattern Theme 2a uses for memo confidence. Goals from the roadmap stay; mechanism switches.

## Why

Three real gaps in current `action_trust`:

1. **No audit history.** Only `last_state_change_at`; no record of who/why/when across the lifetime.
2. **No decay.** Once a class is `AUTO`, it stays `AUTO` forever absent a correction. Trust earned 6 months ago for a now-unused action shouldn't auto-apply silently.
3. **No consecutive-failure escalation.** N corrections in a row triggers nothing beyond the standard `AUTO → ASK` demotion. A persistently bad-acting class should escalate to `DENY` automatically.

## Goals

- Add the audit ledger.
- Add time-based decay of `AUTO` state.
- Add consecutive-failure escalation to `DENY`.
- Preserve `check_action` hot path: flat table stays as the cached current-state column.

## Non-goals

- Replacing the flat `action_trust` table.
- Trust-edges between action classes (silent composition is the wrong default).
- Promoting action classes to entities.
- Per-tool decay timers (one global knob for v1).
- `explain_action_trust` MCP tool (Theme 4 introspection).

## Anchoring decisions

**Why flat table + ledger, not edges:**
- Hot-path lookup. `check_action` is called before every tool call; direct table read is the right primitive.
- Audit history is *temporal* (state changes over time), not relational (between actions). Ledger fits.
- Same pattern as Theme 2a (memo confidence) — keeps mental model consistent.

**Why decay defaults to 90 days:**
- Half a quarter of unused-time is a reasonable "you should re-confirm" threshold.
- Tuneable via config; not load-bearing on the architecture.

**Why consecutive-correction threshold = 3:**
- Two corrections might be one bad week. Three in a row is a pattern. Empirical; revisit if telemetry suggests.
- Tuneable.

**Why no silent cross-class composition:**
- A user grants trust to one specific action. If they wanted to trust a sibling action, they'd say so.
- Implicit trust transfer is exactly the bug `update_action_policy` exists to prevent.

## Section 1 — Schema

```surql
DEFINE TABLE action_trust_ledger SCHEMAFULL TYPE NORMAL;
DEFINE FIELD class       ON action_trust_ledger TYPE string;             -- 'tool:action'
DEFINE FIELD old_state   ON action_trust_ledger TYPE option<string>;
DEFINE FIELD new_state   ON action_trust_ledger TYPE option<string>;
DEFINE FIELD action      ON action_trust_ledger TYPE string;
  -- 'initial' | 'success' | 'correction' | 'manual_promote' | 'manual_demote' | 'decay' | 'auto_block'
DEFINE FIELD set_by      ON action_trust_ledger TYPE string;
  -- 'default' | 'user' | 'agent' | 'correction_loop' | 'decay_sweep'
DEFINE FIELD reason      ON action_trust_ledger TYPE option<string>;
DEFINE FIELD ts          ON action_trust_ledger TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON action_trust_ledger TYPE option<object> FLEXIBLE;
DEFINE INDEX atl_class_ts  ON action_trust_ledger FIELDS class, ts;
DEFINE INDEX atl_action    ON action_trust_ledger FIELDS action;
```

## Section 2 — `runtime:action_trust.config`

```json
{
  "decay_days": 90,
  "consecutive_corrections_to_block": 3,
  "default_state": "ASK"
}
```

## Section 3 — Behavior additions

### 3.1 Ledger emission

Every state-changing call in `src/jobs/action-trust.js` emits a ledger row alongside the existing table UPDATE:

```js
// in setActionTrust:
const old = await getActionTrust(db, cls);
await db.query(surql`UPDATE action_trust MERGE ${{ state, set_by, last_state_change_at: new Date() }} WHERE class = ${cls}`);
await db.query(surql`
  CREATE action_trust_ledger CONTENT {
    class:     ${cls},
    old_state: ${old?.state ?? null},
    new_state: ${state},
    action:    ${old?.state === state ? 'success' : (state === 'AUTO' ? 'manual_promote' : 'manual_demote')},
    set_by:    ${set_by},
    reason:    ${reason ?? null}
  }
`);
```

Similar additions to `recordOutcome` (success / correction) and `demoteOnCorrection`.

### 3.2 Decay sweep

New heartbeat job `action-trust-decay`, every 6h:

```surql
LET $cutoff = time::now() - $decay_days * 1d;
LET $stale = (SELECT id, class, state FROM action_trust
              WHERE state = 'AUTO' AND (last_used_at IS NONE OR last_used_at < $cutoff));
FOR $row IN $stale {
  UPDATE $row.id SET state = 'ASK', set_by = 'decay_sweep', last_state_change_at = time::now();
  CREATE action_trust_ledger CONTENT {
    class:     $row.class,
    old_state: 'AUTO',
    new_state: 'ASK',
    action:    'decay',
    set_by:    'decay_sweep',
    reason:    'unused for ' + <string> $decay_days + 'd'
  };
}
```

### 3.3 Consecutive-correction → block

In `recordOutcome(cls, 'correction')`:

```js
// existing: increment correction_count, demote AUTO→ASK
// new: check consecutive-correction count
const recent = await db.query(surql`
  SELECT action FROM action_trust_ledger
  WHERE class = ${cls}
  ORDER BY ts DESC
  LIMIT ${config.consecutive_corrections_to_block}
`).collect();

const consecutiveCorrections = recent[0]
  .filter(r => r.action === 'correction' || r.action === 'success')
  .reduce((n, r) => r.action === 'success' ? 0 : n + 1, 0);

if (consecutiveCorrections >= config.consecutive_corrections_to_block) {
  await setActionTrust(db, cls, 'DENY', 'correction_loop');
  await db.query(surql`
    CREATE action_trust_ledger CONTENT {
      class: ${cls}, old_state: 'ASK', new_state: 'DENY',
      action: 'auto_block', set_by: 'correction_loop',
      reason: ${consecutiveCorrections} + ' consecutive corrections'
    }
  `);
}
```

A subsequent `success` outcome resets the counter naturally (the reducer above sees `success` and returns 0).

### 3.4 `update_action_policy` accepts `reason`

```js
inputSchema: {
  type: 'object',
  properties: {
    class: { type: 'string' },
    state: { type: 'string' },
    reason: { type: 'string' },  // NEW
  },
  required: ['class', 'state'],
}
```

`reason` is passed to the ledger row for audit.

## Section 4 — Cost envelope

- Per state change: +1 INSERT to ledger. Microseconds.
- Decay sweep (every 6h): one indexed SELECT + ≤ N UPDATEs. Trivial.
- Consecutive-correction check: one indexed SELECT (LIMIT N). Microseconds.
- Zero LLM cost. Zero new embeddings.

Well within roadmap §4 envelope.

## Section 5 — Verification gates

1. **Every state change logged:** `setActionTrust`, `demoteOnCorrection`, decay-sweep, auto-block all emit one ledger row each with correct `action` field.
2. **Decay sweep selective:** stale `AUTO` (`last_used_at < now - decay_days` or NONE) demoted; recently-used `AUTO` untouched; non-AUTO untouched.
3. **Consecutive-correction → DENY:** 3 corrections in a row triggers `state = 'DENY'`; a single `success` between corrections resets the count.
4. **Manual override resets counter:** after auto-block, `update_action_policy({state: 'AUTO'})` clears the block, logs `manual_promote`.
5. **Replay correctness:** for any class, applying ledger rows chronologically reproduces current `state`, `success_count`, `correction_count`.
6. **Per-class history retrievable:** `SELECT FROM action_trust_ledger WHERE class = $cls ORDER BY ts ASC` returns full audit trail.
7. **Never-used class untouched by decay:** an `ASK`-state class with `last_used_at = NONE` stays `ASK` (not promoted).
8. **`reason` propagates:** `update_action_policy({class, state, reason})` → ledger row's `reason` field matches.

## Section 6 — File-by-file changes

**Created:**

- `src/jobs/internal/action-trust-decay.js` — heartbeat job impl.
- `src/jobs/builtin/action-trust-decay.md` — manifest (`0 */6 * * *`).
- `tests/unit/action-trust-ledger.test.js`
- `tests/unit/action-trust-decay.test.js`
- `tests/unit/action-trust-consecutive-block.test.js`
- `tests/integration/action-trust-replay.test.js`

**Modified:**

- `src/schema/migrations/0001-init.surql` — add `action_trust_ledger` table, seed `runtime:action_trust.config`.
- `src/jobs/action-trust.js` — every state change writes a ledger row; consecutive-correction check in `recordOutcome`.
- `src/mcp/tools/update-action-policy.js` — accept optional `reason` parameter.
- `docs/architecture.md` — action-trust lifecycle section update.
- `docs/faculties.md` — discretion section adds ledger + decay + escalation.

## Section 7 — Sequencing within Theme 2b

1. **Schema:** ledger table + config row. Additive.
2. **Ledger emission** in existing `action-trust.js` producers. Additive (no behavior change yet beyond writing rows).
3. **Decay sweep** heartbeat job. Behavior-additive (only acts on stale `AUTO`).
4. **Consecutive-correction → DENY** logic. Behavior-additive.
5. **`update_action_policy` reason parameter.** Additive (optional).
6. **Tests + verification gates.**

## Section 8 — Dependencies

- **Waits for** `feat/surrealdb-improvements` merge (engine swap; nothing structural).
- **Feeds Theme 4 (observability):** `explain_action_trust(class)` MCP tool — designed in Theme 4 — reads the ledger.
- Independent of Themes 1a / 1b / 1c / 2a.

## Section 9 — Open questions (post-impl review)

- **Per-tool decay timer.** Short-lived contexts (Discord) might want 30 days; long-lived (Spotify queue) might want 180. One global knob for v1; revisit if data shows pain.
- **Block state naming.** Existing code uses both `DENY` and `BLOCK` informally. Pick one canonical name in impl (lean: `DENY` to match `BashPreToolUse` hook vocabulary).
- **Cross-class inheritance.** If real cases surface ("trust gmail_send → also trust gmail_send_draft"), add a `inherit_from: option<string>` field. Defer until real signal.
- **Decay during long inactivity.** If Robin is dormant for 90+ days, every `AUTO` decays on first boot back. Probably desired (re-confirm trust after long pause) but worth flagging as a UX consideration.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella; mechanism update noted in this spec's preamble.
- `2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md` — same ledger pattern, applied to memo confidence.
- `src/jobs/action-trust.js` — primary producer site.
- `src/mcp/tools/check-action.js`, `update-action-policy.js` — agent-facing tools.
