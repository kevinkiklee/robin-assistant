# Robin From Scratch — Design Specification

**Date:** 2026-05-26
**Purpose:** A self-contained spec that an AI coding agent can use to build a
personal AI assistant (Robin) from scratch. No reference implementation
required.
**Target reader:** A skilled developer with an AI coding agent. Hand this doc
to the agent and say "build this."
**Environment:** Agnostic. The spec describes abstract capabilities (persistent
storage, LLM access, scheduled jobs) — the builder picks concrete tools.
**LLM:** Model-agnostic. Any provider, any model.

---

## Table of Contents

1. What Is Robin?
2. Phase 1: Foundation — Event Store + Scheduler
3. Phase 2: Memory — Recall, Entities, Beliefs
4. Phase 3: LLM Abstraction — Dispatcher & Providers
5. Phase 4: Cognition — Biographer, Embedder, Dream
6. Phase 5: Integrations — External Data Sources
7. Phase 6: Surfaces — MCP, CLI, HTTP, Primer
8. Phase 7: Agent System — Sandboxed Execution
9. Phase 8: User Data & Extensions
10. Glossary

---

## 1. What Is Robin?

Robin is a **local-first personal AI assistant** that learns about its user
over time. It runs as a background daemon, captures interactions, pulls data
from external services, and builds a structured understanding of the user's
life — relationships, preferences, health, career, finances, creative work. It
exposes this understanding to any AI coding tool (Claude Code, Cursor, Gemini
CLI, etc.) via MCP servers.

### How It All Works Together

A typical session flow:

1. User opens their AI tool (Claude Code, Cursor, etc.)
2. The AI tool loads the **primer** — a compact context file with behavioral
   rules, active beliefs, user profile, and a knowledge index (~2,500 tokens)
3. User asks: "What camera gear do I have?"
4. The AI tool calls Robin's `recall` MCP tool with the query
5. Robin searches the event store (lexical + vector) and returns ranked results
   from knowledge files, past sessions, and integration data
6. The AI tool synthesizes an answer from the results, enriched by the primer's
   context (it already knows the user's name, preferences, and relationships)
7. User says: "Actually, I sold the 24-120 lens last week"
8. The AI tool calls `believe` with topic `sold-24-120` and the claim
9. Session ends — the AI tool's session-end hook sends the transcript to Robin's
   HTTP endpoint
10. Robin's **capture pipeline** classifies the session as personal, ingests it
11. On the next biographer tick (~5 min), the biographer extracts entities
    ("24-120 lens"), relations ("Kevin" → sold → "24-120 lens"), and drafts a
    belief candidate about the gear change
12. On the next dream pass (overnight), the belief candidate is promoted, the
    lens entity's profile is updated, and the daily journal notes the gear
    change
13. Tomorrow's primer reflects the updated beliefs and knowledge

Meanwhile, in the background: Gmail integration pulls new messages every 15
minutes, the calendar integration tracks upcoming events, and the embedder
vectorizes everything for semantic search — all without user intervention.

### Core Principles

- **Personal data only** — Memory is for the user's life (biography,
  relationships, preferences, health, finance, creative work). Engineering
  artifacts (code bugs, git state, npm packages) are structurally excluded from
  the knowledge graph.
- **Local-first** — All data lives on the user's machine. Cloud services are
  optional (for LLM inference or external integrations).
- **Model-agnostic** — Any LLM provider (cloud or local) can power reasoning,
  embedding, and classification. The system abstracts provider details behind
  capability-based routing.
- **Append-only events** — Nothing is deleted, only superseded. Every
  interaction, belief, correction, and prediction is an immutable event with
  provenance.
- **Autonomous cognition** — Background jobs extract entities, build a knowledge
  graph, draft beliefs, and synthesize understanding — all without user
  intervention.
- **Auditable** — Every decision has a trail: event logs, agent transcripts,
  belief provenance, correction history.

### What Robin Is NOT

Robin is not a chatbot, a web app, or a cloud service. It has no conversational
UI of its own. It is infrastructure that makes other AI tools smarter about the
user. The AI tool (Claude Code, etc.) talks to the user; Robin provides that
tool with memory and context.

### What the Builder Needs

- A persistent storage backend with full-text search support (SQL database with
  FTS, or equivalent)
- Vector similarity search capability (database extension, separate index, or
  external service)
- Access to at least one LLM for text generation and one for embeddings (any
  provider)
- A scheduling mechanism (long-running daemon, cron, cloud scheduler, or
  equivalent)
- A process supervisor to restart the daemon on crash (launchd, systemd,
  Docker, or equivalent)
- A way to expose tools to AI assistants (MCP servers, function calling, or
  equivalent)
- Structured logging (JSON or equivalent)

### Build Order

| Phase | Title | Depends On |
|-------|-------|-----------|
| 1 | Foundation — Event Store + Scheduler | — |
| 2 | Memory — Recall, Entities, Beliefs | Phase 1 |
| 3 | LLM Abstraction — Dispatcher & Providers | — |
| 4 | Cognition — Biographer, Embedder, Dream | Phases 1, 2, 3 |
| 5 | Integrations — External Data Sources | Phases 1, 2 |
| 6 | Surfaces — MCP, CLI, HTTP, Primer | Phases 2, 5 |
| 7 | Agent System — Sandboxed Execution | Phases 3, 6 |
| 8 | User Data & Extensions | All prior |

Phases 1 and 3 have no dependencies on each other and can be built in parallel.

---

## 2. Phase 1: Foundation

**Goal:** A running daemon with persistent storage, structured logging,
configuration loading, and a job scheduler with crash recovery.

### Configuration

The daemon loads configuration at startup from user-editable files:

| Config | Purpose |
|--------|---------|
| **LLM config** | Role-to-provider mapping (which model handles reasoning, embedding, classification) |
| **Policies** | Power state, capture rules, network mode, agent budget caps |
| **Secrets** | API keys, OAuth tokens. Stored with restrictive permissions, loaded into environment. |

Config files should be human-editable (YAML, TOML, or similar). Secrets must be
separated from non-secret config and never logged.

### Event Store

The event store is an append-only log. Every meaningful occurrence in the system
becomes an event.

**Event shape:**

| Field | Description |
|-------|-------------|
| `id` | Auto-incrementing unique ID |
| `ts` | ISO-8601 timestamp |
| `kind` | Event type (e.g., `session.captured`, `belief.update`, `integration.tick`) |
| `source` | What created it (e.g., `capture`, `gmail`, `biographer`) |
| `actor` | Optional — who/what triggered it |
| `status` | `ok`, `error`, `skipped` |
| `payload` | Structured metadata (JSON) |
| `content_ref` | Optional FK to a content table for large bodies |

**Content table** (separate from events for scan efficiency — event queries
should not drag large text blobs):

| Field | Description |
|-------|-------------|
| `id` | Auto-incrementing |
| `ts` | Timestamp |
| `body` | Full text content |
| `embedding` | Vector embedding (NULL initially; populated by the embedder in Phase 4) |

Nothing is deleted. Supersession (a new belief replacing an old one) is modeled
as a new event referencing the prior event's ID.

**Full-text search index:** The content table must have a full-text search index
on the `body` column.

**Ingest interface:** A single function that writes an event + optional content
body. Supports upsert-by-external-ID so repeat ingestion of the same external
record (e.g., the same Gmail thread) updates in place rather than duplicating.

### Scheduler

A tick-based job scheduler that claims and executes one job at a time
in-process.

**Job shape:**

| Field | Description |
|-------|-------------|
| `id` | Unique ID |
| `kind` | Job type (e.g., `cognition.biographer`, `integration.gmail`) |
| `status` | `pending`, `running`, `completed`, `failed` |
| `scheduled_at` | When to run |
| `leased_until` | Lease expiry for concurrent-daemon protection |
| `completed_at` | When it finished |
| `error` | Error message if failed |

**Scheduler behavior:**
- Ticks every 1 second
- Claims one pending job whose `scheduled_at <= now`, ordered by
  `scheduled_at` ascending (oldest-first FIFO)
- Sets a lease on the claimed job (protects against a second daemon instance
  claiming the same job — the owning daemon marks the job complete regardless
  of lease expiry, so the lease duration only needs to exceed "time before a
  dead daemon is assumed dead," e.g., 5 minutes)
- Executes the registered handler
- On completion (success or failure), records the result and re-arms cron jobs

**Cron re-arming:** After a job completes (even on failure), if it has a cron
schedule, a new `pending` job is inserted at the next cron time. Transient
failures cannot permanently silence a schedule.

**Crash recovery:** On boot:
1. Check for a stale PID file from a prior daemon
2. Reset any jobs whose lease has expired (prior daemon died mid-execution)
3. Re-arm any cron schedules that should have fired while the daemon was down
4. Handlers that need resumption of partially-completed work (e.g., multi-chunk
   extraction) must implement their own progress tracking — the scheduler only
   guarantees the job re-enters the queue

### Health Monitor

Runs every 60 seconds alongside the scheduler:
- Verifies the scheduler has ticked within the last 5 minutes (CRITICAL if not)
- Verifies database reachability
- After 30 minutes of sustained CRITICAL status, terminates the process for
  respawn by the process supervisor (30 minutes distinguishes genuinely slow
  handlers — which may run 5–15 minutes legitimately — from a wedged scheduler)
- 2-minute boot grace window suppresses false positives during startup
  (migrations, initial job drain)
- Optionally emits desktop/system notifications on critical failures (with
  cooldown to avoid spam)

### Power/Pause Gates

The scheduler respects a configurable power state (`active`, `paused`, `off`).
When paused, the tick loop skips job execution. Platform-specific auto-pause is
optional (e.g., pause on low battery on laptops). The power state is stored in
the policies config file, readable and writable at runtime.

### Phase 1 Done When

- Daemon starts, loads config + secrets, opens database, applies schema
- A handler can be registered for a cron schedule and fires on time
- Scheduler claims and executes jobs in FIFO order
- Jobs re-arm after completion (including after failure)
- Health monitor detects a stalled scheduler and terminates after the
  sustained-critical window
- Crash recovery works: kill the daemon, restart, expired leases reset, cron
  schedules re-arm
- Structured logs are emitted for job claims, completions, failures, and health
  checks

---

## 3. Phase 2: Memory

**Goal:** A memory system that can store, search, and structure knowledge about
the user.

### Recall (Search)

Recall searches the event store by query and returns ranked results. Three
search modes:

| Mode | How it works | When to use |
|------|-------------|-------------|
| **Lexical** | Full-text search index on content bodies | Exact terms, names, specific phrases |
| **Vector** | Cosine similarity on content embeddings | Semantic/conceptual queries |
| **Hybrid** | Both, merged by reciprocal rank fusion | Default — best coverage |

Vector search depends on the embedder (Phase 4). Until then, lexical-only
recall is fully functional.

**Recall returns:** Ranked results enriched with event kind, age, source, and a
relevance score.

### Remember (Write)

A simple interface to write an event to the store with a kind, source, and
content body. This is the public write path — all external data enters through
`remember` or the ingest interface from Phase 1.

### Entity Graph

Entities are the nouns in the user's world. Relations are the connections
between them.

**Entity:**

| Field | Description |
|-------|-------------|
| `id` | Unique ID |
| `type` | Category: `person`, `place`, `organization`, `service`, `topic`, `thing` |
| `canonical_name` | Deduplicated, case-normalized name |
| `profile` | Optional prose summary (generated later by the dream loop) |

**Storage-level deduplication** is case-insensitive by canonical name. Fuzzy
disambiguation (is "Kevin" the same entity as "Kevin Lee"?) is handled at
extraction time by the biographer (Phase 4), not at the storage layer.

**Relation:**

| Field | Description |
|-------|-------------|
| `id` | Unique ID |
| `subject_id` | FK to entity |
| `predicate` | Verb phrase: `lives-in`, `works-at`, `photographed`, `uses` |
| `object_id` | FK to entity |
| `source_event_id` | Which event produced this relation |
| `ts` | When the relation was extracted |

**Entity operations:**
- **Upsert** — Create or find an entity by type + name (case-insensitive
  dedup). Rejects blocked entity types (structural backstop).
- **Find** — Search entities by name substring and optional type filter
- **Traverse** — Given an entity, find all entities connected by N hops
  (default 1)
- **Add relation** — Link two entities with a predicate, sourced to an event

**Blocked entity types:** The entity graph structurally excludes engineering/
dev-internal types. Maintain a configurable blocklist initialized with: `error`,
`repository`, `env_var`, `function`, `library`, `tool`, `schema`, `command`,
`variable`, `file`, `database`, `test_case`, `directory`, `method`, `pipeline`,
`configuration`, `log`, `alias`, `format`, `version`, `software`. Entity upsert
rejects these types at the storage layer. The primary defense is
extraction-time filtering in the biographer (Phase 4); the storage-level
rejection is the structural backstop that prevents graph pollution regardless
of how entities enter the system.

### Beliefs (Supersedable Facts)

A belief is a durable, topic-keyed claim about the user. Only one belief per
topic is "active" at a time — new beliefs on the same topic supersede prior
ones. **Conflict resolution is last-write-wins by timestamp.**

**Belief shape:**

| Field | Description |
|-------|-------------|
| `topic` | Normalized kebab-case key (e.g., `home-location`, `primary-camera`) |
| `claim` | One declarative sentence (e.g., "Kevin lives in Bergen County, NJ") |
| `confidence` | 0.0–1.0 (NULL = unknown) |
| `supersedes` | ID of the prior belief this replaces (NULL for first on topic) |
| `retracted` | Boolean — marks beliefs proven false |
| `provenance` | Evidence class (see Provenance below) |
| `sources` | Event IDs backing this claim |
| `verified_at` | Last confirmed still true |

Beliefs are stored as events (`kind: belief.update`). Querying "current truth"
means finding the latest non-retracted event per topic (the "belief head").

**Belief candidates** — Draft claims awaiting promotion:

| Field | Description |
|-------|-------------|
| `topic` | Same as belief |
| `claim` | Proposed claim text |
| `confidence` | Extraction confidence |
| `source_event_id` | Which event this was extracted from |
| `provenance` | Evidence class |
| `status` | `pending`, `promoted`, `rejected` |

Candidates are drafted by the biographer (Phase 4) and promoted to beliefs by
the dream loop or manually. Promotion sets the candidate's status to `promoted`
and writes a `belief.update` event. Stale candidates (pending > 14 days) are
expired by the dream loop.

### Provenance & Staleness

Each belief carries a provenance class that affects trust and staleness.
Recommended defaults:

| Class | Meaning | Staleness threshold |
|-------|---------|-------------------|
| `first-party` | User explicitly stated this | Never stale |
| `resolver` | Refreshed by an automated check | 7 days |
| `biographer` | Extracted from a session transcript | 30 days |
| `integration` | From an external data source | 30 days |
| `unknown` | Legacy or untracked | 30 days |

Confidence decays over time based on provenance. First-party beliefs don't
decay. Others decay as age increases past their staleness threshold.

### Corrections

When the assistant says something wrong, the user can record a correction:

| Field | Description |
|-------|-------------|
| `what` | What the assistant said (wrong) |
| `correction` | What is actually true |
| `context` | Optional surrounding context |
| `topic` | Optional — if set, triggers automatic belief retraction |

**Two types:**
- **Behavioral** (no topic): Stored as directive rules, surfaced to the AI tool
  at session start via the primer (Phase 6). Persist across sessions as
  behavioral memory.
- **Topic-linked** (topic set): Automatically retract the false belief on that
  topic during the dream pass. The correction IS the review.

### Predictions

Forecasts with confidence and deadlines, used for calibration tracking:

| Field | Description |
|-------|-------------|
| `claim` | What is predicted |
| `confidence` | 0.0–1.0 |
| `deadline` | When this can be resolved |
| `outcome` | `right`, `wrong`, `unverifiable` (NULL until resolved) |
| `brier_delta` | (confidence − outcome)² — calibration score |

Predictions can be resolved manually (user marks outcome) or automatically
(dream loop marks overdue predictions as `unverifiable`). Aggregate Brier
scores reveal whether the system is over/under-confident.

### Phase 2 Done When

- Events can be written via remember/ingest and searched via lexical recall
  (FTS index operational)
- Entities can be upserted (with blocked-type rejection), found by name, and
  traversed by relation
- Beliefs can be written, queried by topic (returns the belief head),
  superseded, and retracted
- Belief candidates can be inserted, listed, promoted (writes a belief.update),
  and rejected
- Corrections can be recorded (both behavioral and topic-linked)
- Predictions can be recorded and resolved (including default unverifiable
  resolution)

---

## 4. Phase 3: LLM Abstraction

**Goal:** A provider-agnostic LLM layer that routes requests by capability,
enforces cost controls, and handles failures gracefully.

### Capability-Based Routing

The system does not call "a model." It calls a **role**. Different roles may be
routed to different providers or models.

**Roles:**

| Role | Purpose | Typical characteristics |
|------|---------|----------------------|
| `reasoning` | Entity extraction, claim drafting, disambiguation, complex analysis | Structured output, moderate speed |
| `summarize` | Entity profiles, journal narratives, depth synthesis | Good prose, long context |
| `classify` | Session classification (dev vs personal), triage | Fast, cheap |
| `embed` | Vector embeddings for semantic search | Deterministic, batch-capable |
| `rerank` | Re-score recall results by relevance | Fast, pair-based |
| `agentic` | Multi-turn tool-use loops (agent runs) | Tool calling, long context, highest quality |

**Configuration:** A config file maps each role to a provider + model. The
builder can route all roles to a single provider/model (simplest setup) or
split across multiple providers for cost/quality optimization.

### Provider Interface

Each LLM provider implements a standard interface:

**Request:**
- System prompt (optional)
- Messages (role + content array)
- Tools (optional — name, description, input schema)
- Output schema (optional — for structured JSON output)
- Max tokens, temperature
- Timeout override (optional)
- Cacheable hint (optional — providers that support prompt caching use this)

**Response:**
- Text response
- Structured output (if schema was provided)
- Tool calls (if tools were provided)
- Usage (input tokens, output tokens, cached input tokens)
- Cost (USD)
- Latency (ms)
- Provider name

**Embed interface** (separate):
- Text or array of texts → array of vectors (dimension determined by model)

**Provider capabilities:** Each provider declares which roles it supports. The
dispatcher validates role assignments at startup: assigning a role to a provider
that doesn't support it produces a startup warning.

### Dispatcher

The dispatcher is the single chokepoint for all LLM calls in the system.

**Responsibilities:**
1. **Route by role** — Look up the configured provider for the requested role
2. **Timeout enforcement** — Every call is wrapped in a timeout (default 5
   minutes, overridable per-call). A hung provider cannot wedge the scheduler.
3. **Spend tracking** — Track cumulative daily USD spend (resets at UTC
   midnight, configurable). Enforce a configurable per-day cap. When the cap is
   hit, raise a clean error (not a crash) so the caller can degrade gracefully.
4. **Lenient registration** — If a provider's API key is missing at startup,
   log a warning but don't crash. The system runs degraded (that role is
   unavailable) rather than failing entirely.
5. **Error classification** — Distinguish between "LLM is unreachable"
   (connection refused, timeout, spend cap) and "LLM returned bad output" (JSON
   parse error, schema mismatch). This distinction is load-bearing: unreachable
   errors should NOT advance processing cursors (retry when recovered), while
   bad-output errors SHOULD advance (one poison input must not block the
   pipeline forever).

### Phase 3 Done When

- Multiple providers can be registered (at least two: one for text, one for
  embeddings)
- Roles are mapped to providers via config, and the dispatcher routes correctly
- Role assignment validation: assigning an embed-only provider to reasoning
  produces a warning
- Timeout enforcement: a deliberately slow provider triggers a timeout error
- Spend cap: after exceeding the daily cap, all calls return a spend-cap error
- Missing API keys produce a warning at startup, not a crash
- Error classification correctly distinguishes unreachable vs bad-output

---

## 5. Phase 4: Cognition

**Goal:** Background jobs that extract structure from raw text, vectorize
content for semantic search, and consolidate knowledge overnight.

### Session Capture

Before the cognition pipeline can process anything, sessions need to be
captured. When the user's AI tool finishes a session, the session transcript is
sent to Robin (via an HTTP hook, file watcher, or integration tick — the
mechanism is environment-specific).

**Capture pipeline:**
1. **Receive** the session transcript (sequence of user/assistant turns)
2. **Scope check** — Optionally restrict capture to sessions from specific
   working directories (configurable allowlist)
3. **Skip rules** — Drop sessions with no assistant turns, empty content,
   single-word acknowledgments ("ok", "thanks"), or pure tool-only output
4. **Dedup** — Hash the user turns; skip if an event with the same hash exists
5. **Classify** — Categorize the session as `dev` or `personal` using a
   lightweight heuristic (keyword density, no LLM call). Conservative —
   ambiguous sessions default to `personal`. Thresholds are tunable.
6. **Ingest** — Write a `session.captured` event with the transcript as content

The biographer skips events tagged `dev`, so engineering-heavy sessions don't
pollute the personal knowledge graph.

### Biographer (Entity & Belief Extraction)

A scheduled job (every 5–15 minutes) that reads unprocessed events and extracts
structured knowledge from them.

**Input events:** `session.captured` (from session capture) and `knowledge.doc`
(from ingest-docs). Integration events (Gmail, calendar, etc.) enter the event
store for recall but do NOT go through biographer extraction — they produce
structured data with known schemas; the biographer is designed for unstructured
narrative text.

**Two extraction passes per event:**

**Pass 1 — Entity & Relation Extraction:**
- Send the event content to the LLM with a prompt requesting structured output:
  `{entities: [{type, name}], relations: [{subject, predicate, object}]}`
- Post-extraction quality filter drops noise: role markers ("USER",
  "ASSISTANT"), bare numbers, git SHAs, state flags ("ON", "OFF"), code
  identifiers (camelCase, snake_case), file paths, dev jargon
- Blocked entity types (from Phase 2) are rejected
- **Disambiguation:** When an extracted name matches multiple existing entities,
  ask the LLM to pick the right one or declare it new

**Pass 2 — Claim Drafting:**
- Separately, send the content with a prompt requesting durable declarative
  facts: `{claims: [{topic, claim, confidence}]}`
- Claims are stable facts that would still be true in a future session
- Exclude: imperatives/rules, transient session details, speculation,
  engineering artifacts
- Each claim becomes a `belief_candidate` (status: `pending`)
- Capped at 20 candidates per event

**Multi-tick chunking:** Large events are split into chunks. The biographer
processes a bounded number of chunks per scheduler tick (e.g., 10), persisting a
progress cursor in the database. The cursor survives daemon restarts — on
restart, the biographer resumes from the last completed chunk.

**Error handling — the critical distinction:**
- **LLM unreachable** (timeout, connection refused, spend cap): Do NOT advance
  the cursor. The event will be retried when the LLM recovers.
- **LLM returns bad output** (JSON parse error, schema mismatch): DO advance
  the cursor. One poison chunk cannot block the pipeline forever.

**Preprocessing:** Before sending to the LLM, strip noise from session
transcripts:
- Remove tool-output blocks (file reads, bash output — zero entities)
- Remove code blocks (triple-backtick fences)
- Collapse consecutive same-role turns
- Drop very short turns (<50 chars)
- For sessions with many assistant turns (configurable threshold, e.g., >10),
  keep only user turns + the final assistant turn

**Knowledge doc handling:** Events from ingest-docs are plain markdown without
transcript role markers. All content is treated as user-authored (no `[USER]`
marker requirement for claim drafting).

### Embedder

A scheduled job (every 1–2 minutes) that vectorizes content for semantic search.

**Behavior:**
- Query the content table for rows where `embedding IS NULL`
- Batch them (e.g., 200 at a time) and send to the embed LLM role
- Write the resulting vectors back to the content table
- Maintain a vector similarity index (mechanism depends on storage backend)

**Decoupled from ingest:** Embeddings are never computed inline during event
ingestion. This keeps the ingest path fast. Semantic recall lags new events by
at most one embedder cycle (~1–2 minutes). Lexical recall is instant regardless.

### Ingest Docs

A scheduled job (every 10 minutes) that indexes markdown files from the user's
knowledge and profile directories.

**Behavior:**
- Scan configured content directories for `*.md` files
- For each file, compute a content hash (SHA-256)
- If no prior event exists for this file path, ingest as a `knowledge.doc`
  event
- If a prior event exists with a different hash, update in place (nullify
  embedding so the embedder re-vectorizes)
- If the hash matches, skip (unchanged)

**Two purposes:**
1. **Recall** — Knowledge files become searchable via lexical and vector recall
2. **Biographer extraction** — `knowledge.doc` events are processed by the
   biographer for entity/relation extraction and claim drafting

### Dream (Nightly Consolidation)

A scheduled job that runs once per night. Consolidates the day's extractions
into higher-level understanding.

**Deterministic pass (no LLM required):**
1. **Resolve overdue predictions** — Mark predictions past their deadline as
   `unverifiable`, compute Brier scores
2. **Roll up daily metrics** — Entity counts, handler activity, calibration
3. **Detect narrative arcs** — Find recurring themes across recent events
   (rolling 14-day window). One approach: cluster by shared entity overlap
   across ≥2 events. The specific algorithm is implementation-dependent.
4. **Expire stale candidates** — Delete belief candidates pending > 14 days
5. **Belief freshness scan** — Check each active belief head against its
   provenance-based staleness threshold. If stale and a registered resolver
   exists, attempt refresh. Otherwise flag with a `belief.stale` event.
6. **Replay corrections** — For topic-linked corrections, retract the
   corresponding belief head (write a superseding event with `retracted: true`)
7. **Promote candidates** — Auto-promote when: confidence ≥ 0.8, no existing
   belief head on the same topic, and provenance is `biographer` or stronger.
   Flag as conflicting (remain pending for human review) when a candidate
   contradicts an existing belief head.
8. **Merge near-duplicates** — When two pending candidates share the same topic
   and highly similar claim text (e.g., edit distance < 20% of shorter claim),
   keep the higher-confidence one, resolve the other.

**Synthesis pass (requires LLM):**
9. **Summarize hot entities** — Entities with many new relations since last
   summary get a regenerated prose profile
10. **Generate daily journal** — Narrative summary of the day's events, arcs
11. **Depth insights** — Optional cross-cutting observations from recent arcs

The synthesis pass gracefully degrades: if no LLM is available, the
deterministic pass completes and the journal contains metrics only.

### Cognition Job Schedule

| Job | Schedule | LLM Required | Timeout |
|-----|----------|-------------|---------|
| Biographer | Every 5–15 min | Yes (reasoning) | Per-chunk: 2 min |
| Embedder | Every 1–2 min | Yes (embed) | Per-batch: 2 min |
| Ingest Docs | Every 10 min | No | N/A |
| Dream | Once nightly | Optional (summarize) | Per-call timeouts |

### Phase 4 Done When

- Session capture receives transcripts, classifies dev/personal, deduplicates,
  and writes `session.captured` events
- Biographer extracts entities + relations and drafts belief candidates from
  both `session.captured` and `knowledge.doc` events
- Biographer correctly handles LLM-unreachable (no cursor advance) vs
  bad-output (advance past poison chunk)
- Quality filter drops noise entities; blocked types are rejected
- Disambiguation resolves extracted names against existing entities via LLM
- Multi-tick chunking persists progress and survives daemon restarts
- Embedder vectorizes content in batches
- Ingest-docs indexes markdown files with content-hash dedup
- Dream resolves predictions, expires stale candidates, promotes
  high-confidence candidates, retracts corrected beliefs, flags stale beliefs,
  generates a journal
- Dream degrades gracefully without an LLM

---

## 6. Phase 5: Integrations

**Goal:** A framework for connecting Robin to external APIs and local data
sources, with a tick-based lifecycle, action dispatching, and user-extensible
plugins.

### Integration Contract

Each integration is a self-contained module with:

**Manifest** (declarative metadata):

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (e.g., `gmail`, `google-calendar`) |
| `version` | Semver |
| `schedule` | Cron expression for tick frequency |
| `permissions` | Memory read/write, network hosts, required secrets |
| `actions` | Optional MCP action definitions (name, description, input schema) |

**Handler** (runtime behavior):

| Method | Required | Purpose |
|--------|----------|---------|
| `tick(ctx)` | No | Periodic data fetch and event ingestion |
| `init(ctx)` | No | One-time setup on daemon start |
| `cleanup(ctx)` | No | Teardown on daemon stop |
| `health(ctx)` | No | Health check (returns `{ok, message?}`) |

Not all integrations have a `tick`. Some are action-only (respond to on-demand
queries but don't poll).

### Integration Context

Every handler receives a context object:

| Field | Purpose |
|-------|---------|
| `db` | Database access |
| `llm` | LLM dispatcher |
| `state` | Per-integration key-value store, database-backed (persists across restarts). For OAuth tokens, cursors, watermarks. |
| `log` | Structured logger scoped to this integration |
| `fetch` | HTTP client |
| `ingest(input)` | Write events to the store (primary output mechanism) |
| `checkOutbound(input)` | PII/secret guard for outbound writes |

### Tick Lifecycle

1. Scheduler claims the integration's cron job
2. `tick(ctx)` is called inside a **timeout** (e.g., 120 seconds)
3. Integration fetches external data via `ctx.fetch()`
4. Integration writes events via `ctx.ingest()` (dedup by content hash)
5. Returns `{status, ingested?, message?}`
6. Scheduler records a completion event
7. Health monitor tracks consecutive errors

**Missing secrets:** When a manifest declares required secrets and they're
absent at startup, the integration is skipped with a warning — the daemon
continues running.

### Actions (On-Demand Queries)

Some integrations expose **actions** — typed functions callable via MCP tools:
- A name (e.g., `search`, `get_thread`)
- An input schema (typed parameters)
- A handler: `(params, ctx) → result`

Actions run in the same context as ticks, with the same timeout and PII guards.

### Discretion (Outbound Write Guards)

Before sending data to an external service, integrations call
`checkOutbound()`, which scans content for:
- **PII patterns:** Credit card numbers (Luhn-validated), SSNs
- **Secret patterns:** API keys (OpenAI, Anthropic, AWS, Google, Stripe,
  GitHub, Slack), tokens

If a match is found, the write is blocked and the attempt is logged for audit.

### Reference Integration Set

| Integration | Schedule | Purpose |
|-------------|----------|---------|
| Gmail | Every 15 min | Inbox messages — subjects, senders, snippets |
| Google Calendar | Every 30 min | Upcoming events — attendees, descriptions |
| Linear/GitHub | Every 30 min | Issues, PRs, status changes |
| Browser history | Every 12 hours | Local browser DB — recent visits |
| Finance/Stocks | Every 15 min | Price quotes for tracked symbols |
| Weather | Every hour | Current conditions at user's location |

### User Extensions

Users add integrations by placing a manifest + handler in the extensions
directory. Same contract as built-in integrations. The simplest implementation
is restart-to-reload; hot-reload via file watcher is an optimization.

### Phase 5 Done When

- Integrations load from built-in and user extension directories
- Tick-based integrations run on cron schedule and ingest events
- Action-only integrations respond to on-demand MCP queries
- Tick timeout prevents hung API calls from blocking the scheduler
- Content-hash dedup prevents duplicate events
- Outbound write guard blocks PII and secrets
- Health monitor tracks errors per integration
- Missing secrets skip the integration, not crash the daemon
- At least one integration works end-to-end

---

## 7. Phase 6: Surfaces

**Goal:** Expose Robin's memory and capabilities to AI tools (MCP), provide a
setup/maintenance CLI, run an HTTP hook endpoint, and assemble session-start
context via the primer.

### MCP Servers

Robin exposes two MCP servers (or equivalent tool interfaces). Splitting keeps
the tool count manageable.

**Core server** (memory + cognition + self-model):

| Tool | Purpose |
|------|---------|
| `recall` | Search events (lexical, vector, or hybrid) |
| `remember` | Write an event to the store |
| `find_entity` | Search entities by name/type |
| `get` | Fetch entity, event, or belief by ID |
| `list` | List events, entities, jobs, predictions, corrections |
| `believe` | Write a belief (topic-keyed, auto-supersedes) |
| `recall_belief` | Query current truth by topic |
| `record_correction` | Log an error + fix |
| `predict` | Record forecast with confidence + deadline |
| `audit` | Read event log (filter by kind, source, time) |
| `explain` | Narrative explanation of a recall, action, or decision |
| `health` | Daemon health status |
| `metrics` | Calibration scores, entity counts, prediction stats |
| `journal` | Daily narrative from dream |
| `power` | Read/write daemon power state |
| `skill` | Load reusable methodology files (markdown playbooks) |

**Extension server** (integrations + agent + graph):

| Tool | Purpose |
|------|---------|
| Integration actions | Dynamically generated from loaded integrations |
| `related_entities` | Entity graph traversal (N-hop) |
| `resolve_prediction` | Mark a prediction as resolved |
| `integration_status` | Per-integration health |
| `ingest` | Direct event write |
| `agent` | Run an agentic task (Phase 7) |
| `check_action` | Pre-flight trust check for risky operations |
| `update` | Update runtime policies/rules |

Integration tools are dynamically generated from action definitions. When
integrations change, MCP clients may need to reconnect to see updated tool
lists.

### CLI

One-time setup and maintenance (not a daily interface):

| Command | Purpose |
|---------|---------|
| `init` | Create user-data dirs, install process supervisor, register MCP servers |
| `doctor` | Health check: database, LLM, integrations, disk |
| `reauth <name>` | Refresh OAuth tokens |
| `reindex` | Force re-embedding all content |
| `power <state>` | Set daemon power state |

### HTTP Server

Lightweight server for webhooks and health probes:

| Endpoint | Purpose |
|----------|---------|
| `POST /hook/session-end` | Receive session transcripts from AI tool |
| `GET /health` | Health probe for process supervisor |
| `GET /ready` | Readiness probe |

### Primer (Session-Start Context)

Assembled on demand at session start. Gives the AI tool immediate awareness of
the user without expensive LLM calls.

**Assembled from existing data (deterministic, no LLM):**

| Section | Content | Budget |
|---------|---------|--------|
| Behavioral rules | Corrections without a topic (directives from past mistakes) | ~5,000 chars |
| Active beliefs | Current belief heads: topic + claim + confidence | ~2,000 chars |
| User profile | Inlined character/voice profile files | ~2,000 chars |
| Knowledge index | Titles of knowledge files (from frontmatter or filename) | ~1,000 chars |
| Pending items | Counts of pending candidates, stale beliefs, unresolved predictions | ~200 chars |

**Total budget:** ~10,000 chars (~2,500 tokens).

**Recommended delivery:** Write to a well-known file path (e.g., `PRIMER.md`)
that the AI tool reads at session start. Most portable — works with any tool
that reads files at startup. MCP resource delivery is cleaner where supported.
Hook-based injection is most seamless but AI-tool-specific.

### Phase 6 Done When

- Both MCP servers expose their full tool sets
- AI tool can recall, remember, search entities, read/write beliefs
- Integration actions are callable through the extension server
- CLI initializes a fresh instance, runs health checks, refreshes auth
- HTTP endpoint receives transcripts and triggers capture
- Primer assembles context under character budget
- Fresh session starts with primer loaded

---

## 8. Phase 7: Agent System

**Goal:** A guarded primitive for multi-turn LLM tool-use loops with cost
controls, isolation, and full auditability.

### Why Agents?

Most cognition (biographer, dream) is single-turn. Some tasks require
multi-turn reasoning — the LLM calls a tool, inspects the result, decides next
steps, calls another tool, and so on. Examples: research across multiple
sources, organize knowledge files, reconcile conflicting beliefs, generate a
morning briefing.

### The runAgent Primitive

All agentic execution flows through a single guarded function. No other code
path may run multi-turn LLM loops.

**Parameters:**

| Parameter | Description |
|-----------|-------------|
| `goal` | Natural language task description |
| `surface` | Caller identity (e.g., `on-demand`, `autonomous`) |
| `allowedTools` | Explicit list of permitted tools (no "allow all") |
| `maxTurns` | Maximum conversation turns |
| `timeoutMs` | Wall-clock deadline |
| `maxBudgetUsd` | Maximum USD spend for this run |
| `model` | Which LLM model (routed through dispatcher) |
| `workdir` | Working directory for file operations |

**Behavior:**
1. **Pre-flight cap check** — Check per-surface daily cap. If exceeded, return
   `capped` immediately.
2. **Run the loop** — Goal + tools → LLM → tool calls → results → LLM →
   repeat until done or limit hit.
3. **Enforce limits** — Hard deadline via abort signal. Turn counter. Per-run
   budget. Any limit → graceful stop.
4. **Stream transcript** — Every message written to a JSONL file per run.
5. **Record usage** — One ledger row: tokens, cost, status, surface, duration.
6. **Return status** — `success`, `capped`, `timeout`, `error`. Returns a
   clean status for all expected failure modes; unexpected errors (OOM, disk
   full) may still propagate.

### Isolation & Safety

**Tool allowlisting:** Every run declares an explicit list of allowed tools.
Write-capable tools require explicit opt-in.

**Worktree isolation:** Write-capable runs operate in an isolated copy of the
working directory (git worktree, temp directory, or container). After the run,
changes are available for review — the caller decides whether to apply them to
the live working tree. The worktree is cleaned up after the decision.

**OS-level sandboxing:** Required for write-capable runs. Confine shell
commands to the run's working directory (macOS seatbelt, Linux bubblewrap,
container). **Fail-closed:** if the platform can't sandbox, the run errors
rather than proceeding unsandboxed.

**Single-flight lock:** One agent run per surface at a time. Concurrent runs
across different surfaces are allowed (e.g., one on-demand + one autonomous).

### Cost Controls

| Layer | Scope | Purpose |
|-------|-------|---------|
| Per-run budget | Single run | Prevent a runaway run |
| Per-surface daily cap | All runs on a surface per day | Prevent budget exhaustion |
| Global daily cap | All LLM calls system-wide | Dispatcher-level (Phase 3) |

**Recommended defaults:**

| Surface | Daily cap | Per-run budget | Max turns | Timeout |
|---------|-----------|---------------|-----------|---------|
| On-demand | $50 | $5 | 30 | 30 min |
| Autonomous | $25 | $5 | 30 | 30 min |

### Agent Handlers

A registry of specialized handlers rather than generic "do anything" agents:

| Handler | Purpose | Surface |
|---------|---------|---------|
| Self-improvement | Refine biographer output, belief quality | Autonomous |
| Research | Multi-source web research | On-demand |
| KB curation | Organize, deduplicate knowledge files | Autonomous |
| Belief reconciliation | Resolve conflicting beliefs | Autonomous |
| Gap fill | Identify and fill knowledge gaps | Autonomous |
| Daily brief | Journal + calendar + weather → morning briefing | Autonomous |
| Health remediation | Diagnose and fix system issues | Autonomous |
| Integration authoring | Build new integrations from API docs | On-demand |

The registry is extensible — users can add custom handlers.

### Phase 7 Done When

- `runAgent` executes multi-turn tool-use loops
- Per-run budget, turn limit, and timeout enforce correctly
- Per-surface daily cap returns `capped` without LLM call
- Every run produces a JSONL transcript
- Usage ledger records cost, tokens, status per run
- Tool allowlisting prevents unauthorized tool use
- Worktree isolation prevents writes to live working tree
- OS sandbox is fail-closed for write-capable runs
- At least one handler works end-to-end

---

## 9. Phase 8: User Data & Extensions

**Goal:** Define the directory layout, extension system, first-run setup, and
multi-machine considerations.

### User Data Directory

```
user-data/
├── config/
│   ├── llm-config.*          # Role-to-provider mapping
│   ├── policies.*            # Power, capture, network, agent caps
│   └── secrets/
│       └── .env              # API keys, tokens (restrictive perms)
│
├── state/
│   └── db/
│       └── robin.*           # Database file(s)
│
├── content/
│   ├── profile/              # WHO the user is
│   │   ├── character.md      # Personality, communication style
│   │   ├── relationships.md  # Key relationships
│   │   └── people/           # Per-person files
│   ├── knowledge/            # WHAT the user knows
│   │   ├── career-timeline.md
│   │   ├── medical/
│   │   ├── finance/
│   │   └── ...
│   └── artifacts/            # Generated outputs
│
├── extensions/
│   ├── integrations/         # User-added integrations
│   ├── jobs/                 # User-added scheduled jobs
│   └── skills/               # User-added methodology files
│
├── logs/
│   └── daemon.log
│
└── agent-runs/               # Per-run JSONL transcripts
```

### Content Directories

**`content/profile/`** — Who the user is. Character, voice, relationships.
Inlined by the primer and indexed for recall.

**`content/knowledge/`** — Domain knowledge. Organized by topic. Indexed for
recall and processed by the biographer.

**Both enforce the personal-data-only principle:** No engineering artifacts,
code documentation, or dev session logs.

### Extension System

**Integrations** (`extensions/integrations/<name>/`): Same contract as built-in.
Full access to integration context.

**Jobs** (`extensions/jobs/<name>/`): Custom scheduled tasks with cron schedule.

**Skills** (`extensions/skills/<name>.md`): Markdown methodology files. User
skills shadow system-provided skills of the same name.

### First-Run Setup (`init`)

1. Create `user-data/` directory structure
2. Generate default config files with sensible defaults
3. Prompt for or detect LLM provider credentials
4. Initialize database, apply schema migrations
5. Install process supervisor configuration
6. Register MCP servers with the AI tool (or provide instructions)
7. Install session-capture hooks
8. Run `doctor` to verify

### Multi-Machine Operation

Robin is designed for single-machine operation. For multi-machine memory:

1. Store `content/` and `extensions/` in a synced repo (private git,
   Syncthing, etc.)
2. Symlink into each machine's `user-data/`
3. Run `init` on each machine (own database, config, secrets)
4. Each machine runs its own daemon and database

**The database is NOT synced.** It's a derived index over content files +
integration data + session transcripts. Two machines would have different
sessions and integration data; syncing would cause conflicts.

**Limitation:** The entity graph, relations, and belief heads are produced by
the biographer from session transcripts and knowledge docs. A new machine's
graph starts empty and builds from:
- Synced knowledge files (via ingest-docs → biographer)
- New sessions on that machine

Session history from other machines does not transfer. The knowledge files
carry the durable content; the graph rebuilds organically.

### Phase 8 Done When

- `init` creates complete user-data, installs daemon, registers MCP servers
- `doctor` verifies database, LLM, integration health
- User integrations in `extensions/` are loaded and scheduled
- User skills shadow system skills
- Content files are indexed and searchable
- Fresh machine: `init` + synced content → running Robin

---

## 10. Glossary

| Term | Definition |
|------|-----------|
| **Belief** | A durable, topic-keyed claim about the user stored as an event. Only one belief per topic is active (the "belief head"). |
| **Belief candidate** | A draft claim extracted by the biographer, awaiting promotion to a full belief or rejection. |
| **Belief head** | The latest non-retracted belief event on a given topic — the "current truth." |
| **Biographer** | A scheduled cognition job that extracts entities, relations, and belief candidates from unstructured text. |
| **Blocked entity types** | Engineering/dev-internal entity types structurally excluded from the knowledge graph (e.g., `repository`, `function`, `env_var`). |
| **Claim** | A declarative sentence asserting a fact (used in beliefs and predictions). |
| **Correction** | A record of something the assistant said wrong, plus the fix. Behavioral (no topic) or topic-linked (triggers belief retraction). |
| **Cron re-arming** | After a job completes, a new pending job is inserted at the next cron time — even after failure. |
| **Disambiguation** | LLM-driven resolution of an extracted entity name against existing entities (is "Kevin" the same as "Kevin Lee"?). |
| **Dispatcher** | The single chokepoint for all LLM calls. Routes by role, enforces timeouts and spend caps. |
| **Dream** | The nightly consolidation job: resolves predictions, promotes candidates, retracts corrected beliefs, generates journals. |
| **Embedder** | A scheduled job that vectorizes content rows (NULL embeddings → vectors) for semantic search. |
| **Entity** | A canonical noun in the user's world: person, place, organization, service, topic, or thing. |
| **Event** | An immutable record in the append-only event store. Everything is an event: sessions, beliefs, predictions, corrections, integration ticks. |
| **Ingest** | Write an event (+ optional content body) to the event store, with external-ID-based dedup. |
| **Ingest-docs** | A scheduled job that indexes markdown files from content directories into the event store. |
| **Integration** | A module that connects Robin to an external data source (Gmail, Calendar, etc.) via a tick/action contract. |
| **Knowledge doc** | A markdown file in the user's knowledge or profile directory, ingested as a `knowledge.doc` event. |
| **Lease** | A timestamp on a job that prevents concurrent daemon instances from claiming the same work. |
| **Narrative arc** | A recurring theme detected across multiple recent sessions (e.g., "photography competition preparation"). |
| **Primer** | A deterministic context payload assembled at session start — behavioral rules, beliefs, profile, knowledge index. |
| **Provenance** | The evidence class of a belief: `first-party`, `resolver`, `biographer`, `integration`, `unknown`. Affects trust and staleness. |
| **Recall** | Search the event store by query (lexical, vector, or hybrid). |
| **Relation** | A subject–predicate–object triple linking two entities (e.g., "Kevin" → lives-in → "Astoria"). |
| **Role** | An LLM capability (reasoning, summarize, classify, embed, rerank, agentic). Mapped to providers via config. |
| **runAgent** | The single guarded function through which all multi-turn LLM tool-use loops execute. |
| **Session capture** | The pipeline that receives AI tool transcripts, classifies them, and writes `session.captured` events. |
| **Skill** | A markdown playbook encoding a reusable methodology (e.g., "how to debug performance issues"). |
| **Staleness** | A belief is stale when its age exceeds its provenance-based threshold and it hasn't been re-verified. |
| **Supersede** | Replace a prior belief on the same topic with a newer one. The prior belief remains in the event store but is no longer the active head. |
| **Surface** | A caller identity for agent runs (on-demand vs autonomous). Each surface has its own daily cost cap. |
| **Tick** | An integration's periodic data-fetch cycle, executed by the scheduler on a cron schedule. |
| **Worktree** | An isolated copy of the working directory where write-capable agent runs execute, preventing mutation of the live tree. |
