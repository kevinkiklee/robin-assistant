# Robin v2 Phase 4b.1 — Action Policy + Action-Trust Ledger

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4b.1 (first sub-phase of Phase 4b from `2026-05-10-robin-v2-phase-4a-safety-floor-design.md`)
**Predecessors:** Phase 2b (`record_correction` MCP tool, `recall_events` schema), Phase 2d-2f (the three outbound tools: `discord_send`, `github_write`, `spotify_write`).
**Sibling-aware:** Coordinates around 4f conversation capture — does NOT touch `src/capture/`, `src/hooks/handlers/`, `src/daemon/sessions.js`, `runtime_sessions`, `runtime_auto_recall_telemetry`, `src/cli/commands/biographer-*`.

---

## 1. Goal

Per-action-class permission states (AUTO / ASK / NEVER) for every outbound write. Trust is tracked per `(tool, action_template)` tuple — e.g. `discord_send:send_dm` is a separate class from `discord_send:send_channel`. Default state for any new class is **ASK**. State demotes automatically on user correction. Manual user promotion via CLI or MCP tool.

This phase ships:
- The trust ledger schema + helpers
- Two new MCP tools (`check_action`, `update_action_policy`)
- A `force: true` escape hatch on every outbound tool's args
- Pre-call trust checks wired into `discord_send`, `github_write`, `spotify_write`
- Auto-demotion plumbing into the existing `record_correction` tool
- 4 CLI subcommands (`robin actions <list|show|set|reset>`)
- AGENTS.md block describing the protocol

## 2. Out of scope

- **Dream-driven auto-promotion proposals.** v1 has these (24h auto-finalize, eligibility based on N successes). Manual-only promotion in this phase; auto-promotion is a 4b.1b follow-up sub-phase.
- **Probation period after promotion.** v1 has a 7-day probation where AUTO captures still emit. Deferred; v2 ledger tracks `last_state_change_at` so adding it later is straightforward.
- **90-day decay** (idle AUTO → ASK). Deferred. Same rationale.
- **NEVER override**. NEVER is a hard refusal — no escape hatch from the tool call. To resume use, the user must flip via CLI/MCP. (Spec choice for safety; revisit if there's a real need.)
- **Action classes for non-write tools** (`recall`, `find_entity`, `list_*`). Read-only tools don't need trust gating.

## 3. The action class

A class is `<tool_name>:<action_template>`. Examples:

| Tool | Action templates | Classes |
|---|---|---|
| `discord_send` | `send_dm`, `send_channel` | `discord_send:send_dm`, `discord_send:send_channel` |
| `github_write` | `create-issue`, `comment`, `label`, `mark-read` | `github_write:create-issue`, `github_write:comment`, `github_write:label`, `github_write:mark-read` |
| `spotify_write` | `queue`, `skip`, `playlist-add` | `spotify_write:queue`, `spotify_write:skip`, `spotify_write:playlist-add` |

**Tools with a single action** (or no `action` arg) use the class `<tool_name>:_default`. None of the current 3 outbound tools needs this, but future tools may.

**Tools that already have richer fan-out** (e.g. a future `gmail_write` with `reply`/`draft`/`send`) carve up by template. The classification is a one-line lookup in the tool's handler — `const cls = \`${name}:${input.action}\`;` — not LLM-driven.

## 4. Schema (migration 0012)

```sql
DEFINE TABLE action_trust SCHEMAFULL;
DEFINE FIELD class            ON action_trust TYPE string;
DEFINE FIELD state            ON action_trust TYPE string ASSERT $value IN ['AUTO', 'ASK', 'NEVER'];
DEFINE FIELD set_by           ON action_trust TYPE string ASSERT $value IN ['user', 'correction', 'default'];
DEFINE FIELD success_count    ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD correction_count ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD last_used_at     ON action_trust TYPE option<datetime>;
DEFINE FIELD last_state_change_at ON action_trust TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at       ON action_trust TYPE datetime VALUE time::now();
DEFINE INDEX action_trust_class ON action_trust FIELDS class UNIQUE;
```

`class` is the unique key. `state` is the live decision input. `set_by` distinguishes the three ways a state arrives: `default` (auto-created on first sight), `user` (CLI/MCP explicit flip), `correction` (auto-demoted by `record_correction`). `success_count` / `correction_count` accumulate over the row's lifetime — useful for future auto-promotion. `last_state_change_at` is the moment the current state began; the agent surfaces it when refusing ("ASK since 3 days ago"). `updated_at` re-triggers on any UPDATE via `VALUE time::now()`.

## 5. Helpers (`src/jobs/action-trust.js`)

```ts
checkActionTrust(db, tool, action): Promise<{
  class: string,
  state: 'AUTO' | 'ASK' | 'NEVER',
  last_state_change_at: Date,
  set_by: string,
}>
// Creates the row with state='ASK', set_by='default' if missing. Reads otherwise.

setActionTrust(db, class, state, set_by): Promise<void>
// Explicit flip. Sets last_state_change_at = now, set_by as given.

recordOutcome(db, class, outcome: 'success' | 'correction'): Promise<void>
// Bumps the matching count, sets last_used_at = now.
// On 'correction' + current state === 'AUTO': also demotes to 'ASK' with set_by='correction'.

demoteOnCorrection(db, class): Promise<{ demoted: boolean, from?: string }>
// Same as recordOutcome('correction') but returns whether it actually demoted, for caller logging.

listActionTrust(db): Promise<Array<row>>
// All rows, ordered by class asc.

getActionTrust(db, class): Promise<row | null>
// Single row, no auto-create.

resetActionTrust(db, class): Promise<void>
// Flip back to state='ASK', set_by='default', preserves counts and timestamps.
```

## 6. Flow

### 6.1 At outbound tool call

Each outbound tool's handler gains a pre-check at entry:

```js
const cls = `${this.name}:${input.action ?? '_default'}`;
const trust = await checkActionTrust(db, this.name, input.action ?? '_default');
const force = input.args?.force === true;

if (trust.state === 'NEVER') {
  return { ok: false, reason: 'action_not_allowed', class: cls };
}
if (trust.state === 'ASK' && !force) {
  return {
    ok: false,
    reason: 'requires_permission',
    class: cls,
    last_state_change_at: trust.last_state_change_at,
    hint: 'pass force:true in args if user just authorized; or update_action_policy({class, state:"AUTO"}) for standing permission',
  };
}
// AUTO, or ASK with force:true → proceed with the existing handler body
```

After a successful call (post existing capture/log/return):

```js
await recordOutcome(db, cls, 'success');
```

The tool returns its existing success shape — no behavior change for callers when state is AUTO or ASK+force.

### 6.2 Demotion on correction

The existing `record_correction` MCP tool (Phase 2b) gains two optional args: `{tool?: string, action?: string}`. When both are present, after the existing correction-event write, call `demoteOnCorrection(db, '${tool}:${action}')`. The tool's response shape adds `{ ...existing, demoted_class?: 'discord_send:send_channel'}` when a demotion occurred, so the agent surfaces "I've moved that to ASK for next time."

When the tool/action args are absent, `record_correction` works exactly as it does today — no demotion, no class touched. Backward compatible.

### 6.3 Manual state flip

CLI: `robin actions set <class> <state>` runs `setActionTrust(db, class, state, 'user')`.

MCP: `update_action_policy({class, state})` does the same. The agent calls this when the user instructs ("you can always queue spotify tracks without asking" → agent calls `update_action_policy({class: 'spotify_write:queue', state: 'AUTO'})`). The tool refuses with `{ok:false, reason:'invalid_state'}` if `state` isn't one of the three.

## 7. MCP tools

### 7.1 `check_action({tool, action})` — read-only

```ts
{
  name: 'check_action',
  description: 'Inspect the current trust state for a tool/action class without invoking it. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string' },
      action: { type: 'string' },
    },
    required: ['tool', 'action'],
  },
  handler: async ({tool, action}) => ({
    class: `${tool}:${action}`,
    state: trust.state,
    set_by: trust.set_by,
    last_state_change_at: trust.last_state_change_at,
    success_count: trust.success_count,
    correction_count: trust.correction_count,
  })
}
```

Auto-creates the row with state='ASK' on first sight, same as the in-tool check. So calling `check_action` before attempting is a safe peek.

### 7.2 `update_action_policy({class, state})` — agent-facing flip

```ts
{
  name: 'update_action_policy',
  description: 'Set the trust state of an action class to AUTO, ASK, or NEVER. Use when the user gives standing permission ("you can always X") or revokes it ("never X again").',
  inputSchema: {
    type: 'object',
    properties: {
      class: { type: 'string', pattern: '^[a-z_]+:[a-z_-]+$' },
      state: { type: 'string', enum: ['AUTO', 'ASK', 'NEVER'] },
    },
    required: ['class', 'state'],
  },
  handler: async ({class: cls, state}) => {
    if (!['AUTO', 'ASK', 'NEVER'].includes(state)) return {ok: false, reason: 'invalid_state'};
    await setActionTrust(db, cls, state, 'user');
    return {ok: true, class: cls, state};
  }
}
```

No agent-side authentication beyond "the agent only calls this when the user explicitly says so" — same trust model as the rest of the agent surface.

## 8. CLI

```
robin actions list                       # table: class | state | set_by | last_used | last_change | successes | corrections
robin actions show <class>               # all fields for one row
robin actions set <class> <auto|ask|never>   # explicit user flip
robin actions reset <class>              # back to default ASK, counts preserved
```

Both `list` and `show` are read-only (open DB directly when daemon is up; otherwise refuse with "daemon not running"). `set` and `reset` flip via daemon `/internal/actions/set` and `/internal/actions/reset` POST endpoints so the daemon's running DB stays the single writer.

## 9. Daemon endpoints

Two new `/internal/actions/*` POST routes:

- `/internal/actions/set` — body `{class, state}` → calls `setActionTrust(db, class, state, 'user')`.
- `/internal/actions/reset` — body `{class}` → calls `resetActionTrust(db, class)`.

Existing `/internal/actions/list` and `/internal/actions/show` are NOT created — the CLI reads directly via daemon-request shape, mirroring how `robin jobs list` works. (Reusing the `daemonRequest` helper from 4d.)

## 10. AGENTS.md

New regenerable block `<!-- robin-actions:start -->`:

```
## Action policy (AUTO / ASK / NEVER)

Outbound tools (discord_send, github_write, spotify_write, future writes)
have a per-action trust state. Each (tool, action) tuple is its own class:
e.g. `discord_send:send_dm`, `github_write:create-issue`.

- AUTO — proceed without asking.
- ASK — refuse with `requires_permission`; surface to user; on user
  approval, retry with `args.force = true`. Don't auto-force; the user
  has to actually say yes.
- NEVER — refuse always. No force override. To resume use, the user
  must explicitly run `robin actions set <class> ASK` or call
  `update_action_policy({class, state: 'ASK'})` on their behalf.

Default state for any new class is ASK. The state demotes AUTO → ASK
automatically when you call `record_correction({tool, action, ...})`.

When the user gives standing permission ("you can always queue songs
for me"), call `update_action_policy({class, state: 'AUTO'})`. When
they revoke ("don't ever do that again"), set state to 'NEVER' or 'ASK'
depending on whether you should ever try it again.

Use `check_action({tool, action})` to peek the current state before
trying — useful when planning multi-step actions.
```

Inserted between `<!-- robin-knowledge-ops:end -->` and the memory-tools content in `agentsMdContent`. No new arg to `agentsMdContent` — the block is static (doesn't depend on DB state).

## 11. Tool-wrapping details

### 11.1 `discord_send` — `src/integrations/discord/tools/discord-send.js`

Add `force` to the args schema (no schema enforcement; just don't include it in the unknown-arg check). At handler entry, after the rate-limit + missing-arg checks but BEFORE the gateway/allowlist/outbound-policy checks:

```js
const cls = `discord_send:${action}`;
const trust = await checkActionTrust(db, 'discord_send', action);
if (trust.state === 'NEVER') return { ok: false, reason: 'action_not_allowed', class: cls };
if (trust.state === 'ASK' && args.force !== true) {
  return {
    ok: false,
    reason: 'requires_permission',
    class: cls,
    last_state_change_at: trust.last_state_change_at,
  };
}
```

After the successful send + capture event write, before returning:

```js
await recordOutcome(db, cls, 'success');
```

### 11.2 `github_write` — `src/integrations/github_write/tools/github-write.js`

Identical pattern. Action templates are the four declared in §3.

### 11.3 `spotify_write` — `src/integrations/spotify_write/tools/spotify-write.js`

Identical pattern. Action templates: `queue`, `skip`, `playlist-add`.

## 12. `record_correction` wiring

The existing `src/mcp/tools/record-correction.js` is in 4f-adjacent territory (the correction surface is part of Phase 2b memory work — NOT capture-pipeline). Read it first; if it's been modified by the 4f agent's rename pass, adapt to the current shape.

Add to its `inputSchema.properties`:
```js
tool: { type: 'string', description: 'optional — name of the tool whose action was wrong' },
action: { type: 'string', description: 'optional — action template that was wrong' },
```

After the existing correction-event write, BEFORE returning:

```js
let demoted_class = null;
if (input.tool && input.action) {
  const cls = `${input.tool}:${input.action}`;
  const r = await demoteOnCorrection(db, cls);
  if (r.demoted) demoted_class = cls;
}
return { ...existingReturn, demoted_class };
```

`demoted_class` is `null` when the correction wasn't about an action, or when the action was already in ASK/NEVER.

## 13. Tests

**Unit:**
- `action-trust.test.js` — `checkActionTrust` auto-creates with default ASK; `setActionTrust` flips + sets `set_by`; `recordOutcome('success')` increments + updates `last_used_at`; `recordOutcome('correction')` increments and auto-demotes AUTO→ASK; `demoteOnCorrection` returns `{demoted: true, from: 'AUTO'}` on AUTO row, `{demoted: false}` on ASK row; `resetActionTrust` flips back to ASK + 'default'.
- `check-action.test.js` — MCP tool returns the row shape; first call auto-creates.
- `update-action-policy.test.js` — MCP tool valid state flips; invalid state refused.
- `discord-send-trust.test.js` — ASK state refuses without force; ASK + force proceeds; AUTO proceeds; NEVER refuses even with force; after success, success_count increments.
- `github-write-trust.test.js` — same pattern for all 4 actions.
- `spotify-write-trust.test.js` — same pattern for all 3 actions.
- `actions-cli.test.js` — list/show/set/reset with injected deps.
- `record-correction-demote.test.js` — record_correction with `tool`+`action` demotes AUTO→ASK; without those args, no demotion.
- `agents-md-actions.test.js` — robin-actions block exists, mentions AUTO/ASK/NEVER, mentions `force: true` and `update_action_policy`.

**Integration:**
- `actions-roundtrip.test.js` — Seed DB → confirm new tool defaults to ASK → CLI `robin actions set` flips to AUTO → tool call succeeds without force → simulate correction via `record_correction({tool, action})` → trust auto-demotes back to ASK → next tool call refuses without force.

Approx test count: ~35 unit + 1 integration. Brings full suite to ~975.

## 14. Migration / rollout

1. Migration 0012 runs on next `robin migrate` (or installer).
2. After daemon restart, all existing outbound tool calls will hit the new check. **Important:** the first call to any (tool, action) creates the row with `state: ASK`. This means any agent code that previously called e.g. `discord_send:send_dm` will now get `requires_permission` on the first call after upgrade. **This is the intended behavior** — but it means the user MUST manually flip the classes they want to be AUTO at first use, OR the agent must surface the refusal correctly.
3. The user's first-day flow after upgrade: `robin actions list` shows nothing; agent attempts an action; tool refuses; user says yes; agent retries with force; later user runs `robin actions set discord_send:send_dm AUTO` for standing permission.
4. AGENTS.md regen on next `robin install` host-CLI re-registration (or manual install rerun).

## 15. Risk register

- **Friction on day 1.** Every outbound tool's first call after upgrade fails until the user trusts it. Mitigated by: clear refusal message with `class` and `hint`, agent surfaces it well per AGENTS.md, CLI is easy.
- **Agent ignores AGENTS.md and never calls `update_action_policy` even after user said "yes always".** Possible; user can always run `robin actions set` manually. The CLI is the always-available escape hatch.
- **Race between `record_correction` demoting and another in-flight call to the same class.** Daemon is single-process; tool handlers don't run in parallel within one MCP request, but two concurrent MCP clients could race. Acceptable — worst case one extra "AUTO" call slips through before the demote lands. Real demotion still applies for all subsequent calls.
- **NEVER as a kill-switch.** If the user accidentally sets a class to NEVER, they need CLI to recover (agent can't unstuck via `update_action_policy` — actually it CAN, since the policy tool isn't itself trust-gated). Acceptable.
- **The `force: true` arg path is the agent's responsibility to set correctly.** If the agent forgets to pass it after user approval, the tool re-refuses and the agent loops. AGENTS.md is the only mitigation; if this becomes a pain point, a `--auto-force-next-call` shape could be added later.

## 16. Open questions / explicit deferrals

1. **Auto-promotion proposals (4b.1b).** Dream-driven proposals: classes with N successes in M days without corrections become candidates; user has 24h to object; auto-finalize. Defer until manual flow has usage data.
2. **Probation period after promotion.** v1 has 7-day probation where AUTO captures still emit even though they're settled. Defer; ledger tracks `last_state_change_at` for future use.
3. **Idle decay.** v1 demotes idle AUTO classes back to ASK after 90d. Defer.
4. **Class introspection from the agent side.** If the agent wants to know "what classes are AUTO right now" before planning a multi-step action, it can call `check_action` repeatedly, but a `list_action_policies({state?: 'AUTO'})` MCP tool would be cleaner. Defer until the agent demonstrably wants this.

## 17. Phase exit criteria

- All tests green (~35 unit + 1 integration).
- After daemon restart and a fresh agent session: calling `discord_send` for the first time produces `requires_permission` with `class: 'discord_send:send_dm'` and `last_state_change_at`.
- User runs `robin actions set discord_send:send_dm AUTO` → next call succeeds without force.
- User invokes `record_correction({tool: 'discord_send', action: 'send_dm', content: 'wrong recipient'})` → next call again returns `requires_permission` (auto-demoted).
- `robin actions list` shows all 9 baseline classes (3 discord + 4 github + 3 spotify − the `_default` ones that don't apply) plus any others encountered during testing.
- AGENTS.md `<!-- robin-actions:start -->` block renders.
