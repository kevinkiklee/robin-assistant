# Robin v2 Evolution Roadmap — above the schema

**Status:** Working draft (umbrella spec; per-theme specs to follow)
**Date:** 2026-05-11
**Predecessors:**
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — merged; substrate-of-3 + generic edges + faculty lenses + reinforcement loop.
- `2026-05-11-surrealdb-improvements-design.md` — in flight on `feat/surrealdb-improvements`; engine swap, `TYPE RELATION` + arrow traversal, BM25+vector hybrid retrieval, hot-path batching, REFERENCE back-refs.

## 1. Why these four themes, why now

After the db-and-memory redesign (shipped) and the surrealdb-improvements branch (in flight), Robin's substrate is stable: 3 substrate tables, 1 generic edges table, separable embeddings, registries for kinds. What hasn't been touched is the **layer above the schema** — how memory ages, how belief evolves, when reflection happens, how Robin explains itself.

These four concerns share a common shape: they're about Robin's **cognitive lifecycle**, not its data model. This roadmap names them, sequences them, and defers detailed design to one per-theme spec each.

## 2. Theme summaries

**Theme 1: Memory shape & lifecycle** — three independently shippable sub-projects:

- **1a. Compaction & forgetting** — near-duplicate consolidation, age-based summarize-and-drop, archival tier. Tackles long-term storage growth and recall noise.
- **1b. Episode model expansion** — episodes become first-class arcs with summaries, transitions, arc-level recall. Anchors working memory across days.
- **1c. Scope semantics rework** — hierarchical scopes with inheritance; finer privacy levels. Replaces flat strings.

Each sub-project can ship without the others; bundled here because they share the lifecycle theme.

**Theme 2: Belief & confidence** — two sub-projects:

- **2a. Evidence ledger** — confidence becomes derivable from accumulated corroboration/refutation events, not frozen at write time.
- **2b. Action-trust ledger** — flat `action_trust` table gains an audit ledger (same pattern as 2a), time-based decay of `AUTO` states, and consecutive-failure escalation to `DENY`. (The roadmap's original "trust edges so trust composes" framing was refined during the 2b brainstorm; silent cross-class composition turns out to be the wrong default, so the mechanism shifted to a temporal ledger. See the 2b spec for the rationale.)

**Theme 3: Cognition cadence** — *extends* the existing 5-min reinforcement loop rather than replacing it. Specifically: which dream steps can run on triggers (correction landed → reflection in ~5 min) vs which must remain nightly (cross-day consolidation, calibration). Hard cost constraint: token budget per hour stays within the same envelope as today's nightly run, or the change isn't worth shipping.

**Theme 4: Observability & introspection** — agent-facing MCP tools (`explain_recall`, `explain_belief`, `show_reasoning`) plus telemetry roll-ups (per-faculty 7-day health, daily memo-by-source counts). Whether to introduce a new structured-audit table or unify existing telemetry tables is an open question for the Theme 4 spec.

## 3. How the themes relate (coordinated, not strictly gated)

```
                ┌─► Theme 2 (Belief): benefits from 1a (compaction stabilises
Theme 1 (Shape) ┤                     memo identity over time); does NOT require it.
                └─► Theme 3 (Cadence): unchanged by 1.

Theme 2 (Belief) ───► Theme 3 (Cadence): continuous reflection has more to do
                                          if evidence ledger exists; can land
                                          first using existing signal_count.

Theme 4 (Observability) reads everything. Can ship in slices alongside themes 1–3
(each theme adds a faculty Theme 4 then surfaces), or land as one block after.
```

No strict prerequisites — order below is recommended, not enforced. Per-theme specs can reorder if it makes sense at the time.

**Recommended sequence:** 1a (compaction — highest immediate value, lowest risk) → 1b (episode expansion) → 2a (evidence ledger) → 2b (action-trust-as-graph) → 3 (cadence extension) → 4 (observability, possibly in parallel from 2a onward) → 1c (scope rework — separable, lowest urgency).

## 4. Acceptance criteria per theme

Measurable invariants only; per-spec gates come later in the per-theme specs.

- **Theme 1a (compaction):** total memo count grows sub-linearly with event ingest over a 30-day synthetic load; recall@10 on golden fixture set does not regress >2%.
- **Theme 1b (episodes):** episode-scoped recall returns coherent arcs (validated on a fixture of multi-session arcs); episode summaries persist and are recall-targetable.
- **Theme 1c (scopes):** scope hierarchy resolves correctly under inheritance tests; private-tier scopes never appear in outbound payloads (existing test + new edge cases).
- **Theme 2a (evidence ledger):** confidence-derived-at-time-t reproducible from ledger replay; recall ranking using derived confidence ≥ ranking with frozen confidence on golden set.
- **Theme 2b (action-trust graph):** existing `check_action` / `update_action_policy` MCP behavior preserved bit-for-bit on a regression fixture; new graph queries return identical decisions.
- **Theme 3 (cadence):** correction-to-rule-update latency p50 ≤ 10 min (vs current ~12 hr); 24-hour LLM token spend stays within ±20% of today's baseline.
- **Theme 4 (observability):** `explain_recall(query_id)` returns ranked-hits + score components + lineage in ≤200ms; `robin doctor --health` exits non-zero on synthetic regressions.

## 5. Cross-cutting concerns

- **Cost / token budget.** Each per-theme spec MUST report expected per-hour LLM + embedding cost delta vs today's baseline, with a numeric envelope. `CLAUDE.md` flags token optimisation as first-class.
- **Package vs user-data boundary.** The `robin-assistant` npm package ships skeleton + system code; `user-data/` is gitignored. Each per-theme spec MUST state which artifacts ship in the package vs which are user-instance-only (e.g., a dashboard UI might be optional).
- **Soft conflict with surrealdb-improvements.** Theme 4 reads `recall_log`; the other agent is touching its shape (`_sources`, telemetry fields). Theme 4 starts only after `feat/surrealdb-improvements` merges.
- **Plan-only during the in-flight branch.** All themes are plan-only until (a) `feat/surrealdb-improvements` lands and (b) user signals impl-go.
- **Ledger compaction is its own deferred problem.** Themes 2a (`evidence_ledger`) and 2b (`action_trust_ledger`) introduce append-only ledgers that grow monotonically. Theme 1a's compaction model targets `memos` and (via Theme 1b's hook) `arcs` only — ledgers are out of scope there. Acknowledged here so future maintenance work has a starting point: each ledger's per-record rows should compact after the cached current-state column is stable (e.g., older than 1y AND superseded by N newer entries → archive or aggregate-then-drop). A follow-up spec, not a v1 deliverable.
- **Working-tree fragility.** The per-theme spec files in this session are uncommitted drafts. A `git stash`, `git switch`, or accidental `git restore docs/` loses the planning artifact. Before pausing for more than a session, commit them to a planning branch (`docs(plan): robin v2 evolution umbrella specs`) — even though impl is gated.

## 6. Sequencing across the surrealdb-improvements landing

`feat/surrealdb-improvements` finishes → merge → per-theme brainstorm begins (Theme 1a first, per §3). Each theme is one branch, one PR-equivalent, one verification pass. Roadmap is revisited between themes if dependencies or priorities shift.

## 7. Non-goals (overlap exclusions)

- Schema-level work, hot-path batching, hybrid retrieval, engine swap, REFERENCE/COMPUTED fields — owned by surrealdb-improvements.
- v1 → v2 migrator — deferred (no v2 users).
- Multi-tenant Robin / horizontal scaling — single-user assumption stands.
- Replacing the existing reinforcement loop — it stays; Theme 2a *adds* an evidence ledger upstream of it.
- Reranker model training — uses outputs of Theme 2a + Theme 4; out of scope for the roadmap itself.
- Integration capture lifecycle (per-integration trust posture, inbound rate limiting) — adjacent and worth doing later, but not under this umbrella.
- New embedder profiles or a runtime cache layer.

## 8. Open questions (for the per-theme specs to answer)

- **Theme 1a:** compaction trigger thresholds (count? age? semantic-cluster size?); whether compacted memos retain content or just a summary + back-pointers.
- **Theme 1b:** episode arc grain (per-day? per-task? per-session?); how arc boundaries are detected.
- **Theme 1c:** scope hierarchy syntax (`project:foo/sub` vs tagged set); private-tier granularity.
- **Theme 2a:** evidence-ledger storage shape (memos with `kind='evidence'` vs separate table); derivation function (Beta-distribution-ish? simple weighted vote?).
- **Theme 2b:** which trust edges, what counter semantics, decay model.
- **Theme 3:** which dream steps are trigger-eligible vs nightly-only; trigger debounce; idempotence under repeated triggers.
- **Theme 4:** introspection MCP tool shape; whether to unify or add audit tables; agent memory-hygiene tools (request-deletion, mark-private, flag-duplicate) — in or out?

## See also

- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — the substrate this roadmap builds on top of.
- `2026-05-11-surrealdb-improvements-design.md` — the in-flight schema/engine layer; non-overlapping with this umbrella.
- `docs/architecture.md`, `docs/faculties.md` — current cognitive-architecture reference.
