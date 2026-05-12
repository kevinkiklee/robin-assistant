# Robin v2 Phase 2c — Dream + Memory Shapes + Heuristic Loop Design

**Status:** Design (pre-implementation)
**Author:** Brainstorming session, 2026-05-09
**Targets:** `robin-assistant-v2/` at HEAD `1f98e10` (tag `v6.0.0-alpha.3`).
**Scope:** Phase 2c bundled — dream agent + 6 memory shapes + heuristic correction loop. 60–70 tasks.

Spec context: see `2026-05-09-robin-v2-foundation-design.md` (overall v2 plan), `2026-05-09-robin-v2-phase-2a-design.md` (graph + biographer), and `2026-05-09-robin-v2-phase-2b-design.md` (MCP daemon + tools).

---

## 1. Scope and what's NOT in this slice

Phase 2b delivered the agent surface (MCP daemon + 10 tools + recall/remember/biographer) plus the self-improvement *capture* infrastructure (recall_events, mark_recall_used, record_correction). 2c delivers the *consumption* side: dream agent that consolidates short-term memory into long-term knowledge, surfaces patterns, and turns user corrections into approvable rules.

### Strategic decisions

| Decision | Choice |
|---|---|
| Phase 2c scope | Bundled (dream + all shapes + heuristic loop) |
| Dream cadence | Hybrid: nightly cron + event-count-overflow trigger |
| Rule approval UX | MCP tools + CLI sharing one `rule_candidates` table |
| Auto-approve | Not in 2c — trusted human-in-loop only |
| Profile inference | Surfaces as rule_candidates with kind='profile_update' (no silent updates of sensitive fields) |
| Cron timezone | Daemon reads `process.env.TZ` (set by shell + plist/unit env). Default `cron_hour: 4` to avoid DST spring-forward edge case |
| Correction clustering | Agglomerative single-link on content embeddings; cosine ≥ 0.85; min cluster size 3 |

### LLM access — subprocess-only, no direct API

**Confirmed and pinned:** all LLM calls from dream (and the rest of v2) go through `host.invokeLLM(messages, opts)`, which spawns the active host's CLI as a subprocess (`claude` or `gemini`). No `@anthropic-ai/sdk` dependency; no direct HTTP to `api.anthropic.com`. Cost model is the user's existing host plan (Claude Code Pro/Max for Claude, Google AI Studio for Gemini), not per-token billing on a separate Anthropic account.

This pattern is established in Phase 2a (`src/hosts/claude-code.js` + `src/hosts/gemini.js`); 2c just calls `host.invokeLLM` from each dream pipeline step.

**Pre-2c fix required:** the Phase 2a Claude Code adapter's subprocess args use a stub `['invokeLLM']` token; the real `claude` CLI uses `claude -p <prompt>`. Unit tests pass with a fake spawn, but a real-CLI smoke test will fail. **Phase 2c plan must include a Task 0 that corrects the Claude Code adapter args** (mirror the Gemini adapter's `-p` + `-o json` pattern) and adds a real-CLI smoke test, before any dream-pipeline task can dogfood.

### What's IN

- **Dream agent** — daemon-internal periodic batch.
- **4 new tables:** `knowledge`, `patterns`, `profile`, `threads`.
- **2 derived views (functions, not SurrealDB views):** `journal`, `hot`.
- **2 rules tables:** `rule_candidates`, `rules`.
- **Knowledge promotion** — heuristic surface + LLM confirm.
- **Pattern detection** — heuristic surface + LLM confirm.
- **Heuristic correction loop** — corrections → cluster → rule_candidates → user approve → rules.
- **9 new MCP tools** (consolidated from 14; full enumeration in section 6).
- **8 new CLI commands.**
- **Daemon scheduler** with TZ + DST handling.
- **AGENTS.md update** instructing agent to call `list_rules({status: 'active'})` at session start and surface pending rules conversationally.

### What's NOT in 2c

- ML reranker (Phase 4 — capturing recall_events feedback already, training pipeline later).
- Embedder fine-tuning, LoRA, RLHF (out of v2 scope).
- Integrations (Gmail, Discord, etc.) — Phase 2d.
- Always-on biographer daemon — already deferred.
- Aliases / nickname tables.
- Re-biographing with vocabulary expansion.
- Time-travel queries.
- Episode merge/split UI tools.
- Auto-approval of high-confidence candidates (future opt-in flag possible).

## 2. Schema additions

New migration `0005-dream-and-memory.surql`.

### `events` extension

```surql
DEFINE FIELD dreamed_at ON events TYPE option<datetime>;
DEFINE INDEX events_dreamed ON events FIELDS dreamed_at;
```

### `knowledge` table

```surql
DEFINE TABLE knowledge SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content        ON knowledge TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash   ON knowledge TYPE string;
DEFINE FIELD subject_id     ON knowledge TYPE option<record<entities>>;
DEFINE FIELD confidence     ON knowledge TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD source_events  ON knowledge TYPE array<record<events>>;
DEFINE FIELD source_episodes ON knowledge TYPE array<record<episodes>>;
DEFINE FIELD created_at     ON knowledge TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at     ON knowledge TYPE datetime VALUE time::now();
DEFINE FIELD embedding      ON knowledge TYPE array<float> ASSERT array::len($value) = 384;
DEFINE FIELD meta           ON knowledge TYPE option<object> FLEXIBLE;
DEFINE INDEX knowledge_subject ON knowledge FIELDS subject_id;
DEFINE INDEX knowledge_chash   ON knowledge FIELDS content_hash;
DEFINE INDEX knowledge_vec     ON knowledge FIELDS embedding HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;
```

### `patterns` table

```surql
DEFINE TABLE patterns SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name          ON patterns TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD description   ON patterns TYPE string;
DEFINE FIELD signal_count  ON patterns TYPE int DEFAULT 1;
DEFINE FIELD last_signal   ON patterns TYPE datetime DEFAULT time::now();
DEFINE FIELD strength      ON patterns TYPE float DEFAULT 1.0;
DEFINE FIELD source_events ON patterns TYPE array<record<events>>;
DEFINE FIELD created_at    ON patterns TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta          ON patterns TYPE option<object> FLEXIBLE;
DEFINE INDEX patterns_name ON patterns FIELDS name;
```

### `profile` (singleton: `profile:singleton`)

```surql
DEFINE TABLE profile SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name         ON profile TYPE option<string>;
DEFINE FIELD display_name ON profile TYPE option<string>;
DEFINE FIELD pronouns     ON profile TYPE option<string>;
DEFINE FIELD timezone     ON profile TYPE option<string>;
DEFINE FIELD interests    ON profile TYPE option<array<string>>;
DEFINE FIELD updated_at   ON profile TYPE datetime VALUE time::now();
DEFINE FIELD meta         ON profile TYPE option<object> FLEXIBLE;
```

### `threads` table

```surql
DEFINE TABLE threads SCHEMAFULL TYPE NORMAL;
DEFINE FIELD title       ON threads TYPE option<string>;
DEFINE FIELD started_at  ON threads TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_active ON threads TYPE datetime DEFAULT time::now();
DEFINE FIELD episode_ids ON threads TYPE array<record<episodes>>;
DEFINE FIELD entity_ids  ON threads TYPE array<record<entities>>;
DEFINE FIELD summary     ON threads TYPE option<string>;
DEFINE FIELD meta        ON threads TYPE option<object> FLEXIBLE;
DEFINE INDEX threads_last_active ON threads FIELDS last_active;
```

### `rule_candidates` table

```surql
DEFINE TABLE rule_candidates SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rule_candidates TYPE string;
DEFINE FIELD kind             ON rule_candidates TYPE string
  ASSERT $value IN ['behavior', 'profile_update', 'conflict_warning'];
DEFINE FIELD signal_events    ON rule_candidates TYPE array<record<events>>;
DEFINE FIELD payload          ON rule_candidates TYPE option<object> FLEXIBLE;
DEFINE FIELD confidence       ON rule_candidates TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD status           ON rule_candidates TYPE string
  ASSERT $value IN ['pending', 'approved', 'rejected', 'expired'];
DEFINE FIELD created_at       ON rule_candidates TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD reviewed_at      ON rule_candidates TYPE option<datetime>;
DEFINE FIELD rejected_reason  ON rule_candidates TYPE option<string>;
DEFINE INDEX rule_candidates_status  ON rule_candidates FIELDS status;
DEFINE INDEX rule_candidates_created ON rule_candidates FIELDS created_at;
```

`payload` carries kind-specific data: for `profile_update`, an object with the field updates to apply on approval.

### `rules` table

```surql
DEFINE TABLE rules SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rules TYPE string;
DEFINE FIELD kind             ON rules TYPE string
  ASSERT $value IN ['behavior', 'profile_update'];
DEFINE FIELD payload          ON rules TYPE option<object> FLEXIBLE;  -- preserved from candidate for replayability
DEFINE FIELD source_candidate ON rules TYPE option<record<rule_candidates>>;
DEFINE FIELD priority         ON rules TYPE int DEFAULT 50;
DEFINE FIELD active           ON rules TYPE bool DEFAULT true;
DEFINE FIELD created_at       ON rules TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at       ON rules TYPE datetime VALUE time::now();
DEFINE FIELD meta             ON rules TYPE option<object> FLEXIBLE;
DEFINE INDEX rules_active     ON rules FIELDS active, priority;
```

`kind` and `payload` are copied forward from the source `rule_candidates` row on approval. For `profile_update` rules, `payload.fields` is the field changes that were applied — preserved so a future undo flow can revert them.

### `runtime` additions

```
runtime:dream
  value = {
    last_run_at: datetime,
    last_run_at_success: datetime | null,
    last_error: string | null,
    config: {
      cron_hour: 4,
      event_overflow_threshold: 500,
      knowledge_promotion_min_signals: 3,
      pattern_signal_decay_days: 30,
      rule_candidate_min_corrections: 3,
      correction_cluster_similarity_threshold: 0.85,
      thread_recency_days: 7,
      candidate_expiry_days: 60,
      profile_inference_min_confidence: 0.8,
    }
  }

runtime:scheduler
  value = {
    next_dream_run_at: datetime,
    pending_overflow: bool,
  }
```

## 3. Dream pipeline

Dream runs as `dreamProcess(db, host, embedder)` inside the daemon. Triggered by:
- **Daemon scheduler** (nightly via setTimeout aimed at next cron_hour).
- **Event overflow** (biographer queue worker calls `scheduler.checkOverflow()` after each event; if pending events ≥ overflow threshold, dream is enqueued).
- **Manual trigger** (`robin dream run` CLI or `run_dream` MCP tool).

Concurrent triggers coalesce via in-flight mutex.

### Cycle

1. **Pick events to consider.** All events with `dreamed_at IS NONE` plus correction events from last 30 days.

2. **Cluster + summarize knowledge candidates.** For each entity with ≥ `knowledge_promotion_min_signals` new mentions, ONE LLM call to "knowledge synthesis" prompt; on promote, UPSERT knowledge row with `subject_id` and `content_hash` dedupe.

3. **Detect patterns.** Heuristic surface (co_occurs_with strength jumps ≥ 5 in 7 days, OR ≥ 3 events in same hour-of-day window for one entity). For each candidate, ONE LLM call to confirm + name + describe. UPSERT into patterns.

4. **Correction clustering for rule candidates.** Pull events where `meta.kind = 'correction'` from last `correction_lookback_days` (default 30) — **NOT scoped to `dreamed_at IS NONE`**. Reason: slow-moving preference patterns build up across cycles where individual corrections are alone in their cycle window; scoping to un-dreamed only would lose those signals. Agglomerative single-link on content embeddings; cosine sim ≥ `correction_cluster_similarity_threshold` (0.85); min cluster size = `rule_candidate_min_corrections` (3). **Cluster dedupe:** before proposing a rule for a cluster, check if any existing `rule_candidates` row's `signal_events` overlap the cluster by ≥ 50% — if so, skip (don't duplicate). For each new qualifying cluster, ONE LLM call to propose a rule. CREATE rule_candidates with `kind: 'behavior'`, `status: 'pending'`.

5. **Profile inference (surfaces as candidate, not auto-apply).** Heuristic + LLM detect possible profile signals (name introductions, pronoun mentions, stated timezone, repeated interest keywords). For each candidate field with confidence ≥ `profile_inference_min_confidence` (0.8), CREATE rule_candidates with `kind: 'profile_update'` and `payload: { fields: { name?, pronouns?, ... } }`. **Dedupe:** before CREATE, check for an existing pending or rejected candidate with identical `payload.fields` — skip if found. Prevents pile-up of repeated proposals across cycles. **Approval is what writes profile:singleton.**

6. **Update threads.** For each entity with ≥ 2 episodes in last `thread_recency_days` (7), group episodes into a thread. Update `threads.last_active`.

7. **Mark events as dreamed (idempotent batched commits).** Per-step rollback semantics: events get `dreamed_at` set only after their step's writes succeed. Failed events retry next cycle. Knowledge/pattern UPSERTs are idempotent via stable IDs.

8. **Update runtime.** `runtime:dream.last_run_at_success` set on no-terminal-error completion; `runtime:scheduler.next_dream_run_at` schedules next cron; `pending_overflow = false`.

### Failure handling

- Per-LLM-call: 3× exponential backoff.
- Per-step terminal: log to `runtime:dream.last_error`, skip step, continue cycle.
- Malformed LLM JSON: log warning, skip that candidate.
- Daemon crash mid-cycle: events stay un-dreamed for next run.

### Cost estimate

| Step | Calls/run | Cost (Haiku, cached) |
|---|---|---|
| Knowledge synthesis | 10–50 | $0.05–$0.25 |
| Pattern detection | 3–10 | $0.015–$0.05 |
| Correction clustering | 1–3 | $0.005–$0.015 |
| Profile candidate surfacing | 0–2 | $0.00–$0.01 |
| **Total per nightly run** | | **~$0.10–$0.30** |
| **Monthly** | | **~$3–$10** |

Tunable via `runtime:dream.config`.

## 4. Derived views (journal, hot)

Implemented as functions in `src/memory/journal.js` and `src/memory/hot.js`. NOT SurrealDB materialized views — just SQL helpers.

### `journal`

Chronological feed of significant events.

```js
export async function listJournalEntries(db, { since, until, limit = 50 }) {
  const filters = ['biographed_at IS NOT NONE'];
  // significant = correction OR len(content) >= 50 OR has mentions
  // ... build dynamic WHERE
}
```

Significance threshold tunable in `runtime:dream.config.journal_significance_min_content_len` (default 50).

### `hot`

Active-context view: open episodes (`ended_at IS NONE`) + their recent events (last `hot_window_minutes`, default 30) + mentioned entities + recent knowledge about those entities.

```js
export async function getHotContext(db, { source }) {
  // 1. Find active episodes for source
  // 2. Pull events from those episodes' last 30 min
  // 3. Pull mentioned entities + their recent knowledge
}
```

`hot_window_minutes` tunable in `runtime:dream.config`.

## 5. Heuristic correction loop

End-to-end:

1. User: "no, I prefer concise responses"
2. Agent calls `record_correction(content, prior_response, meta)`.
3. Event written with `source='manual'`, `meta.kind='correction'`.
4. Biographer processes correction event normally.
5. (Async) Next dream run pulls + clusters corrections.
6. For qualifying clusters, LLM proposes rule text.
7. CREATE rule_candidates with `status='pending'`.
8. Next agent session: AGENTS.md instructs agent to:
   - Call `list_rules({status: 'active'})` at session start, fold rules into effective context.
   - Periodically/contextually call `list_rules({status: 'pending'})` and surface candidates conversationally.
9. User says yes/no → agent calls `update_rule(id, 'approve')` or `update_rule(id, 'reject', { reason })`.
10. Approved → CREATE rules row (active=true), copying `kind` and `payload` from candidate; UPDATE candidate `status='approved'`. For `kind='profile_update'`, also apply `payload.fields` to `profile:singleton` via UPSERT MERGE. Rejected → UPDATE candidate `status='rejected'`.
11. Subsequent sessions: `list_rules({status: 'active'})` returns the new rule.

### AGENTS.md additions for 2c

New sections written to AGENTS.md template:

```markdown
## Active rules (read at session start)

At the start of each conversation, call `list_rules({status: 'active'})` once and
fold the returned rules into how you respond. These are user preferences and
corrections the user has previously approved. Apply them silently; don't recite
them back.

## Pending rule candidates

Robin's dream agent periodically surfaces "rule candidates" — patterns from
recent user corrections that might warrant a permanent rule. When you have
opportunity (natural breakpoint, after a correction, or when user asks about
their preferences), call `list_rules({status: 'pending'})` and surface candidates
conversationally:

  "I noticed you've corrected me three times about verbosity in the last week.
   Want me to remember 'prefer concise answers'?"

If user says yes → `update_rule(id, 'approve')`.
If user says no → `update_rule(id, 'reject', { reason: '...' })`.
Don't badger; once per session at most for any given candidate.

## Profile updates as candidates

Profile changes (name, pronouns, timezone, interests) come through the same
`rule_candidates` flow with kind='profile_update'. Same approve/reject pattern.
Approval applies the field changes to the user's profile.
```

### Edge cases

- **Stale candidates** auto-expire at `candidate_expiry_days` (60 default).
- **Conflicting rules** — higher priority wins (default 50; user-tunable via `update_rule(id, 'set_priority', { priority: N })`). Dream surfaces conflicts as candidates with `kind='conflict_warning'`.
- **Rule revocation** — `update_rule(id, 'deactivate')` sets `active=false`. History preserved.
- **Profile candidate races** — UPSERT MERGE on `profile:singleton` is atomic.

## 6. New MCP tools + CLI commands

### MCP tools (9 new — total surface 19)

Consolidated from an earlier 14-tool draft. The rule lifecycle (6 tools) collapses into 2 (`list_rules` + `update_rule`); `set_profile` is dropped because profile updates flow through the candidate→approval path (see section 5) — direct-write would let agents bypass the approval gate.

| Tool | Purpose |
|---|---|
| `get_knowledge(query?, subject_id?, limit?)` | Semantic + filtered query of knowledge |
| `list_patterns(active_only?, limit?)` | Recurring observations |
| `get_profile()` | Singleton profile read (read-only) |
| `list_threads(since?, limit?)` | Recent active threads |
| `list_journal(since?, until?, limit?)` | Journal view |
| `get_hot(source?)` | Hot context view |
| `list_rules(status?)` | `status` ∈ `'pending' \| 'active' \| 'all'` (default `'active'`). Replaces `list_pending_rules` + `get_active_rules`. |
| `update_rule(id, action, options?)` | `action` ∈ `'approve' \| 'reject' \| 'deactivate' \| 'set_priority'`. `options.reason` for reject; `options.priority` for set_priority. Replaces `approve_rule` + `reject_rule` + `deactivate_rule` + `update_rule_priority`. |
| `run_dream()` | Manual trigger |

**Consolidation rationale:**
- `list_rules(status)` keeps the call surface focused while still letting the agent ask for what it needs (`'pending'` for review, `'active'` for session init). Two parameters, one behavior shape.
- `update_rule(id, action, options?)` follows the action-dispatch pattern that LLMs handle well when `action` values are small + named clearly. JSON Schema `enum` constrains valid actions.
- `set_profile` removal: in the prior 14-tool draft, the agent had two paths to mutate profile (direct via `set_profile`, mediated via candidate approval). LLMs gravitate to the simpler direct path, bypassing the approval gate that exists specifically to protect sensitive fields. Single path = no bypass. If user wants to update profile directly: they tell the agent in conversation → agent calls `record_correction(content, meta={kind: 'profile_signal'})` → next dream surfaces a `profile_update` candidate → agent surfaces it → user approves. One extra round-trip; preserves the gate.

### CLI commands (8)

```
robin dream run
robin rules pending
robin rules approve <id>
robin rules reject <id> [reason]
robin rules list
robin rules deactivate <id>
robin journal [--since DATE]
robin hot
```

Both surfaces share the same underlying logic (in `src/memory/*.js` + `src/rules/*.js`).

## 7. Daemon scheduler

`src/daemon/scheduler.js` — heartbeat-based, not pure `setTimeout`. Reason: laptop sleep makes long `setTimeout` delays unreliable (timer fires immediately on wake, missed delay is unrecoverable). A 60-second heartbeat that checks `now() > runtime:scheduler.next_dream_run_at` is robust to suspend/resume.

```js
export function createScheduler({
  runDream, isOverflow, getCronHour, readNextRunAt, writeNextRunAt,
  heartbeatMs = 60_000,
}) {
  let timer = null;
  let inFlight = false;

  function computeNextNightly(cronHour) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(cronHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async function tick() {
    if (inFlight) return;
    const next = await readNextRunAt();
    if (next && new Date() >= new Date(next)) {
      inFlight = true;
      try {
        await runDream({ trigger: 'cron' });
        await writeNextRunAt(computeNextNightly(getCronHour()));
      } finally {
        inFlight = false;
      }
    }
    if (!inFlight && await isOverflow()) {
      inFlight = true;
      try { await runDream({ trigger: 'overflow' }); } finally { inFlight = false; }
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, heartbeatMs);
    timer.unref();
    // Run one tick immediately so a past-due nightly fires on daemon start.
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}
```

**TZ:** daemon reads `process.env.TZ` (set by user's shell + plist/unit env). Document in install command output.

**DST + cron_hour:** default 4 AM (avoids 2-3 AM spring-forward gap).

**Clock-skew + sleep recovery:** `runtime:scheduler.next_dream_run_at` is the source of truth. If daemon was sleeping past the trigger time, the first heartbeat after wake fires it. If daemon was killed and restarted, `start()` runs a tick immediately and triggers any past-due nightly.

**Heartbeat overhead:** one async function call per minute; no DB round-trip if `next_dream_run_at` is cached. Negligible.

## 8. Tests + done checklist

### Test layers

| Layer | Coverage |
|---|---|
| Unit on dream pipeline steps | Each step (knowledge promotion, pattern detection, correction clustering, profile candidate surfacing, threads update) testable in isolation with fake LLM |
| Unit on derived views | `listJournalEntries`, `getHotContext` against synthetic events |
| Unit on memory-shape helpers | `getKnowledge`, `setProfile`, `listPatterns`, etc. |
| Unit on rule lifecycle | `createCandidate`, `approveRule` (incl. profile_update payload application), `rejectRule`, `deactivateRule`, `updateRulePriority` |
| Unit on scheduler | Mock time; verify cron fires at expected interval; verify overflow trigger; verify clock-skew handling on restart |
| Integration: full dream cycle | Seed events + corrections → run dream → verify knowledge/patterns/rule_candidates rows materialize |
| Integration: rule approval round-trip | record_correction → run dream → list_rules({status:'pending'}) → update_rule(id,'approve') → list_rules({status:'active'}) returns it |
| Integration: profile candidate flow | record events with profile signals → dream surfaces candidate → update_rule(id,'approve') applies payload.fields to profile:singleton |
| Integration: AGENTS.md content | Verify agents-md template includes the new rules sections |

### "Phase 2c done" checklist

- [ ] Migration `0005-dream-and-memory.surql` applies cleanly. `events.dreamed_at` field added.
- [ ] All 4 new tables (knowledge, patterns, profile, threads) usable.
- [ ] `runtime:dream` and `runtime:scheduler` rows initialized on first dream run.
- [ ] Dream pipeline: 8 steps each tested in isolation; full cycle integration test passes.
- [ ] Rule candidates surface from correction clusters; user can approve/reject via MCP and CLI.
- [ ] Profile candidates surface separately; approval applies fields to profile:singleton.
- [ ] Active rules retrievable via `list_rules({status: 'active'})` MCP tool; pending via `{status: 'pending'}`; both via `{status: 'all'}`.
- [ ] Daemon scheduler fires nightly + on overflow, with TZ + DST defaults.
- [ ] Manual `robin dream run` works.
- [ ] All 9 new MCP tools have unit tests + are wired into the daemon (total daemon surface 19).
- [ ] All 8 new CLI commands smoke-tested.
- [ ] AGENTS.md template updated with rules sections; existing install command picks them up.
- [ ] Cost: a typical dream run completes in < 60s with ~$0.10–$0.30 spend on real LLM calls (manual validation).
- [ ] Tag `v6.0.0-alpha.4` locally.

## 9. Open questions / risks

| Item | Resolves how |
|---|---|
| Knowledge embedding regeneration on entity rename | Out of scope for 2c. |
| Pattern decay strategy | Linear: -0.1/week without new signal. Configurable. |
| Rule conflict resolution | Higher priority wins; `update_rule(id, 'set_priority')` is user-tunable. Dream surfaces conflicts as `kind='conflict_warning'` candidates. |
| Profile field inference | No silent updates. Always rule_candidates with `kind='profile_update'`; user approves to apply. |
| Auto-expire pending candidates | 60 days default (configurable). |
| Scheduler clock skew on restart | `runtime:scheduler.next_dream_run_at` is source of truth; past-due triggers immediately. |
| Multi-instance dream | Single daemon owns dream (already true from 2b). |
| Cold start | Dream produces empty results, no error. Test covers. |
| Migration coordination | Same daemon-running check as 2b's `robin migrate`. |
| HNSW index on knowledge | Same dim 384. Future: separate dim. |
| Dream LLM call returns malformed JSON | Same handling as biographer: validate, log to last_error, skip candidate, continue. |
| TZ on daemon launchd/systemd | Plist/unit must export user's TZ env; document in install output. |
| Step partial failure | Per-step idempotence (UPSERT by stable id). Events get `dreamed_at` only after step succeeds. |
| Cost overrun on big nightly batches | Tunable thresholds in `runtime:dream.config`. |
| Dangling refs in `source_events` / `signal_events` arrays after future event delete | Same gap as 2b's recall_events; resolves when forget semantics ship (post-2c). |
| Profile race conditions | UPSERT MERGE on profile:singleton is atomic; last-writer-wins. |
| Closed enum on `rule_candidates.kind` and `rules.kind` | 2d (integrations) will likely add `integration_setup` etc. Plan migration `0006-rule-kind-widen.surql` when 2d ships; 2c stays with `'behavior' \| 'profile_update' \| 'conflict_warning'` for candidates and `'behavior' \| 'profile_update'` for rules. |
| Lost-signal in correction clustering across cycles | Mitigated: clustering uses a 30-day rolling window (not `dreamed_at`-scoped) + dedupe by signal-event overlap ≥ 50% so candidates aren't proposed twice. |
| Profile candidate pile-up | Mitigated: dedupe by identical `payload.fields` before CREATE. |
| Scheduler reliability across laptop sleep | Mitigated: heartbeat-based scheduler instead of `setTimeout` for nightly delays; first tick on daemon start fires past-due nightly. |

## 10. Next steps

1. User reviews this spec.
2. On approval, hand off to `superpowers:writing-plans` for the Phase 2c implementation plan.
3. Plan begins with **Task 0: fix Phase 2a Claude Code adapter args** (replace stub `['invokeLLM']` with `claude -p <prompt>` + JSON-output flag, add real-CLI smoke test). Then schema migration, then dream-cycle steps as separate tasks, then memory-shape helpers, then MCP tools, then CLI commands, then scheduler, then integration tests, then AGENTS.md update + tag.
4. Phase 2d (integrations: Gmail, Discord, etc.) starts after 2c is implemented.
