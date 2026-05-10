# Robin v2 Phase 4f — Conversation Capture

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4f (new sub-phase, sequenced after 4a)
**Predecessors:** Phase 4a (safety floor — host-side hooks, `runtime_sessions` with `transcript_path`, Stop hook → biographer subprocess).

---

## 1. Why this is its own phase

v1 had `migrate-auto-memory`: an hourly job that drained Claude Code's `~/.claude/projects/<slug>/memory/` markdown files into the capture table. v2 has no equivalent. The v1→v2 audit (2026-05-10) flagged it as a real gap.

Bridging Claude Code's auto-memory directly is the wrong fix in v2:

- **Host coupling.** v2 supports Claude Code *and* Gemini CLI. Claude Code's auto-memory only exists for Claude Code.
- **Double extraction.** Claude Code already runs an LLM pass to decide what's worth keeping; Robin's biographer would re-extract from the same content.
- **Schema mismatch.** Claude Code writes typed markdown entries (user/feedback/project/reference). Robin wants events → entities/edges/episodes via the biographer.
- **Robin already has a stronger pipeline.** biographer + dream + rules subsumes Claude Code's flat MEMORY.md.

The right model: extend the Stop hook (which fires on every host with `transcript_path` in stdin) to read the latest turn and write it as one `events` row. The existing biographer then takes over.

**Cost: not free.** No new LLM call in the capture step itself, but each non-skipped capture creates one new event that the biographer must process — that's an incremental fast-tier LLM call per captured turn. Without 4f, biographer only runs when `remember`/`record_correction` was explicitly called or an integration wrote an event. With 4f, it runs on every non-skipped turn. The skip heuristics (§5.B) are tuned to filter pleasantries and pure tool-call turns, targeting roughly a 30–50% skip rate on typical sessions. For ~50–200 turns/day this is a meaningful but bounded uplift in biographer cost — the price of complete conversation memory.

This is a hard prerequisite for Phase 4b's comm-style profile work (which needs a steady stream of conversation events to infer style).

## 2. Goal

Restore automatic conversation capture so that Robin's "the next session knows what the last one knew" promise survives without requiring the agent to explicitly call `remember` on everything important.

Working definition: on every Stop fire, capture the last user+assistant turn pair as one `events` row (with content-hash dedup + heuristic skips), then let the biographer extract entities/edges/episodes from it.

## 3. Architectural shift from v1

| Concern | v1 placement | v2 placement | Why moved |
|---|---|---|---|
| Source of capture content | Claude Code's `MEMORY.md` + individual memory files (output of Claude's own LLM extraction) | Host transcript JSONL via `transcript_path` (raw conversation) | Host-agnostic; single source; lets Robin's own biographer do the extraction. |
| Trigger | Hourly cron in v1's job runner | Stop hook (already wired in 4a) | Captures per-turn freshness; no separate scheduler. |
| Extraction LLM | Claude Code's own (we re-extracted with biographer) | Robin biographer only (one LLM call total) | Avoids double LLM cost on the same content. |
| Storage shape | Markdown notes per memory entry | `events` row with `source='conversation'` | Same primitive every other capture uses. |
| Dedup | Filename-based timestamp checks | `content_hash` (sha256, already enforced by `recordEvent`) | Reuses v2's existing dedup. |

## 4. File layout

```
src/
  capture/
    record-event.js                # +'conversation' added to VALID_SOURCES
    transcript.js                  # NEW — tail-and-parse transcript JSONL
    session-capture.js             # NEW — orchestrates transcript → event
  hooks/
    handlers/
      stop-hook.js                 # +forwards transcript_path + session_id to subprocess
  cli/commands/
    biographer-process-pending.js  # +`--transcript-path <p>` `--session-id <id>` flags; runs capture before processing
  daemon/
    server.js                      # +/internal/biographer/process-pending body accepts transcript_path + session_id
tests/unit/
  transcript-parse.test.js         # JSONL parser + last-turn extraction
  session-capture.test.js          # skip heuristics + formatting + dedup
tests/integration/
  conversation-capture-roundtrip.test.js  # stop hook → capture → biographer → entities/episode
```

No new tables. No new migrations. No new daemon endpoints (existing process-pending endpoint extended).

## 5. Components

### 5.A Transcript reader (`src/capture/transcript.js`)

Reads the last ~32 KB of the transcript JSONL (Claude Code & Gemini CLI both write JSONL where each line is one message event). Parses backwards to find the most recent **assistant turn** and the **user prompt that preceded it**. Returns:

```js
{
  userText: string | null,    // concatenated text content of last *human* user message
  assistantText: string | null, // concatenated text from last assistant message (no tool_use/tool_result blocks)
  hasToolCalls: boolean,      // whether the assistant message included any tool_use
  rawTurnHash: string,        // sha256 of "<user>\n\n<assistant>" — used for dedup probe
  tsAssistant: Date | null,
}
```

Parsing rules:

- Each line is JSON; tolerate malformed lines (skip them, keep parsing).
- For Claude Code: messages have shape `{type: 'user'|'assistant', message: {content: [{type, text|...}]}}` or simpler `{type, content}` variants — handle both via a shape-tolerant accessor (same pattern as 4a's `tool_input.command` resolution).
- For Gemini CLI: similar JSONL shape; accessor falls through transparently.
- **Tool blocks excluded from text** — `assistantText` is the concatenation of `text`-type content blocks only. `tool_use` / `tool_result` / `thinking` blocks contribute to `hasToolCalls` but not to text.
- **`tool_result` user messages are NOT the human prompt.** Claude Code stores `tool_result` content blocks inside user-role messages (i.e. the role flips for tool returns). The walk-backwards to find `userText` skips any user-role message whose content contains only `tool_result` blocks; the human user prompt is the first user-role message walking back that has at least one `text` block. (For Gemini CLI: same rule — tool returns appear as a `function_response` role and are skipped.)
- If no assistant turn is found in the tail window, return all-nulls (skip downstream).
- If an assistant turn is found but no preceding human user prompt fits in the window (very long tool chain), accept `userText = null` and rely on `assistantText` alone — biographer can still extract from one side.

### 5.B Skip heuristics (`src/capture/session-capture.js`)

Skip the capture (return without writing) when **any** of:

1. `transcript_path` is null/missing/unreadable.
2. Transcript reader returns null `assistantText` (no assistant turn found in tail window, or empty assistant response).
3. **Single-word ack** — `userText` (trimmed, lowercased) is exactly one of: `ok`, `okay`, `yes`, `no`, `thanks`, `thank you`, `continue`, `go`, `go ahead`, `next`, `sure`, `done`. (`no, don't do that` survives because it's not exact-match.)
4. **Pure-tool turn** — `hasToolCalls === true` AND combined `userText + assistantText` text length (after trim) < 30 chars. Catches "ls" + tool_use + "Done." and similar. Threshold tuned low because tool-call turns frequently contain meaningful short text ("fix it" + Read+Edit + "Fixed.").
5. **Empty turn** — combined `userText + assistantText` trimmed length < 8 chars (catches "hi"/"y"/"."-style noise; does NOT catch "drop it", "fix it", "merge", which are real instructions).
6. **Dedup** — an `events` row already exists with `source='conversation'` AND `content_hash = sha256(formatted_content)`. (The orchestrator computes the hash itself before calling `recordEvent`, because `recordEvent` caches embeddings on `content_hash` but does **not** reject duplicate rows.)

The thresholds in rules 4 and 5 are first-cut. The skip-logger (see below) makes them easy to tune post-deployment.

**Skip logging.** Each skip writes one structured line to the biographer log (`<robinHome>/cache/logs/biographer.log`) with `{ts, session_id, rule, user_len, assistant_len}` — enough to retune thresholds from real data without re-instrumenting.

### 5.C Session capture orchestrator (`src/capture/session-capture.js`)

Single exported function:

```js
async function captureFromTranscript(db, embedder, { transcriptPath, sessionId, host }) → { captured: boolean, eventId?: string, skippedReason?: string }
```

Steps:

1. Read transcript via `transcript.js`.
2. Run skip heuristics. On skip → return `{captured: false, skippedReason}`.
3. Format content as:
   ```
   USER: <userText>

   ASSISTANT: <assistantText>
   ```
   Trim each to 8 KB; total content cap 16 KB. (Biographer prompt budget — bigger content hurts more than it helps.)
4. Call `recordEvent(db, embedder, { source: 'conversation', content, ts: tsAssistant, meta: { session_id: sessionId, host, has_tool_calls } })`.
5. Return `{captured: true, eventId}`.

Fail-soft on every step (try/catch around the whole function in the caller); a transcript-parse failure must not block biographer from processing pre-existing pending events.

### 5.D Stop hook wire-up (`src/hooks/handlers/stop-hook.js`)

Two small changes:

1. Extract `transcript_path` and `session_id` from `args.stdin` (Claude Code Stop hook payload includes both natively per the contract).
2. Append `--transcript-path <p>` and `--session-id <id>` to the spawned `robin biographer process-pending` subprocess args — both for the daemon route (POST body) and the direct-spawn fallback.

No new spawn. Same detached fire-and-forget pattern as 4a.

### 5.E Biographer integration (`src/cli/commands/biographer-process-pending.js` + `src/daemon/server.js`)

The command `robin biographer process-pending` gets a new pre-step:

```
if (--transcript-path provided):
  await captureFromTranscript(db, embedder, {transcriptPath, sessionId, host})  // fail-soft
process pending events as before
```

The daemon's `/internal/biographer/process-pending` endpoint accepts `{since?, transcript_path?, session_id?}` in its POST body and does the same pre-step before draining the pending queue.

This keeps the capture and the biographer pass in the same subprocess (or same daemon handler), so there's no race between "event written" and "biographer queries pending."

## 6. Source naming

Add `'conversation'` to `VALID_SOURCES` in `src/capture/record-event.js`. Host (`claude_code` | `gemini`) goes into `meta.host` for later filtering, instead of splitting into two source values. Single source value keeps recall queries simple (`WHERE source = 'conversation'` covers both hosts).

Rationale: integration source names (`gmail`, `calendar`, `discord`) describe the data origin. `conversation` matches that pattern — the host is a detail, not the identity.

## 7. Edge cases & failure modes

| Case | Behavior |
|---|---|
| `transcript_path` doesn't exist (race with file creation) | Skip with reason `transcript_unreadable`. Biographer still processes pending. |
| Transcript JSONL is malformed midway | Skip malformed lines; continue parsing. If no valid assistant turn found in tail window, skip with `no_assistant_turn`. |
| **Transcript-write race** — host is still flushing the assistant message when Stop fires | Tail read may capture a partial last line. Parser tolerates: malformed final line is dropped, walks back to the previous (complete) assistant message. If that's actually a *prior* turn, the dedup probe (rule 6) catches it on the second Stop fire. Net effect: at worst we miss one turn until the next Stop; we do not double-capture. |
| Same turn fires Stop hook twice (host bug / user retry) | The pre-`recordEvent` dedup probe (§5.B rule 6) finds the existing `events` row by `content_hash` + `source='conversation'` and short-circuits — no second insert, no second biographer call. `recordEvent` itself does **not** dedup (it caches embeddings on `content_hash` but always `CREATE`s a row); the dedup must happen in the orchestrator. |
| Agent calls `remember` mid-turn AND we capture the turn | Two events (one `source='manual'`, one `source='conversation'`) with overlapping content. Different content hashes (the `remember` content is the agent's summary, not the raw turn). Biographer dedupes entities via stable record id. Acceptable. |
| Turn contains secrets that should not be in memory | The inbound PII guard from 4a runs inside `recordEvent`'s `guard` hook. **Not wired by default** for conversation source — the agent's own conversation is treated as trusted user content. **Open decision:** see §10. |
| Very long turn (>16 KB combined) | Content truncated to 16 KB before write; biographer still gets useful signal. |
| Capture step throws an unexpected error | Caught in the command wrapper, logged to biographer log, biographer still runs on pre-existing pending. |
| Stop hook fires with no `transcript_path` (older Claude Code, Gemini before transcript_path landed) | Skip capture; behavior identical to today. |
| User runs `robin biographer process-pending` manually with no `--transcript-path` | Capture step is a no-op (transcript-path-required); existing manual flow unchanged. |

## 8. Tests

**Unit (Node test runner):**

- `transcript-parse.test.js`
  - Parse well-formed Claude Code JSONL (text-only assistant message)
  - Parse JSONL with tool_use blocks (`hasToolCalls === true`, `assistantText` excludes tool blocks)
  - **`tool_result` user messages are walked past** to find the real human user prompt (regression for the §5.A nuance)
  - Tolerate a malformed line in the middle, keep parsing
  - Tolerate a malformed *final* line (transcript-write race) — falls back to the previous complete assistant turn
  - Return all-nulls when no assistant turn in tail window
  - Return `userText = null` + non-null `assistantText` when no human user prompt fits in the tail window (long tool chain case)
  - Handle Gemini CLI variant shape (`function_response` role skipped like `tool_result`)

- `session-capture.test.js`
  - Skip on missing transcript_path
  - Skip on single-word ack (exhaustive — every word in the list)
  - Skip on `hasToolCalls && combined < 30 chars`
  - Skip on `combined < 8 chars`
  - **Do NOT skip** on short-but-meaningful turn ("drop the watches feature", "no, don't do that")
  - **Dedup probe finds existing row by `(source='conversation', content_hash)`** — second call short-circuits without calling `recordEvent`
  - Capture path produces correctly formatted content (`USER:\n\nASSISTANT:\n\n`) + meta (`session_id`, `host`, `has_tool_calls`)
  - Truncation at 8 KB per side, 16 KB total
  - PII guard fires when content contains a credential shape (refusal logged to `outbound_refusals`)
  - Skip-log line written with `{ts, session_id, rule, user_len, assistant_len}`

**Integration:**

- `conversation-capture-roundtrip.test.js`
  - Seed a fake transcript JSONL on disk
  - Invoke `stopHookHandler({stdin: {transcript_path, session_id}})` against a daemon with empty `events`
  - Assert: 1 `events` row with `source='conversation'`, biographer ran (event has `biographed_at`), at least one entity was created, episode opened.

## 9. Migration / cutover

No data migration. No schema migration.

CHANGELOG entry slots in as `v6.0.0-alpha.10` / Phase 4f. README "How Robin works" diagram gets one new arrow:

```
Stop hook ────► transcript-tail → events('conversation') → biographer
```

`bin/robin --version` unchanged. No new install step. No new CLI subcommands user-facing. Existing `robin biographer process-pending` gains two flags but they're invoked automatically from the Stop hook.

## 10. Decisions

**PII guard wired for `source='conversation'`.** The capture orchestrator calls `recordEvent` with `guard: guardInboundContent` (the same wrapper MCP `remember` / `record_correction` use). Rationale: the conversation transcript already lives in the host's `~/.claude/projects/*` JSONL — refusing to capture a secret-containing turn does not unpaste the secret from the transcript file, but it does prevent embedding the secret into Robin's vector index and surfacing it via recall later. Better to have a partial events record than a queryable credential. Refusals are logged to `outbound_refusals(direction='inbound')` (4a) and auditable via `robin refusals list`.

## 11. Non-goals

- **Multi-turn batching.** One Stop fire = one event. Older turns that the Stop hook missed (laptop sleep, crash) are *not* recovered. The reconciler heartbeat in 4d will be the place to walk the transcript backward and catch missed turns; out of scope here.
- **Per-turn LLM extraction step.** The biographer is sufficient — adding a "should we keep this?" LLM call before the biographer would double LLM cost on accepted turns for marginal benefit.
- **Transcript redaction.** The captured content is the raw user/assistant text. If the conversation discussed sensitive material, the existing inbound PII guard (§10 above) is the line of defense; broader redaction is a separate concern.
- **Cross-host transcript merging.** If a topic spans a Claude Code session and a Gemini session, they're captured as separate `conversation` events with different `meta.host`. Linking is biographer/dream's job via entity resolution, not capture's.

## 12. Done criteria

- `'conversation'` is in `VALID_SOURCES`.
- New files exist as in §4 with the exports described in §5.
- Unit + integration tests all pass.
- Stop hook reproducibly produces one `events('conversation')` row per non-trivial turn end-to-end against a live daemon.
- README "How Robin works" updated with the capture arrow.
- CHANGELOG entry drafted under `v6.0.0-alpha.10`.
- `migrate-auto-memory` is now formally accounted for in the v1→v2 mapping (closed as **replaced by 4f**, not deferred or dropped).
