# Robin v2 Phase 2d — Integrations Framework + Gmail + Lunch Money + Discord Bot

**Date:** 2026-05-09
**Status:** Approved (sections 1-6 brainstormed and iterated)
**Predecessor:** Phase 2c shipped at v6.0.0-alpha.4 (`1f7ff77`).
**Target tag:** v6.0.0-alpha.5

## 1. Scope and decomposition

Phase 2d ships:

1. **Integration framework** under `src/integrations/<name>/` — manifest + sync function + per-integration MCP tools + secrets schema + auth helpers. Reusable scaffold for the ~14 remaining v1 integrations.
2. **Three reference integrations** covering the two shapes that matter:
   - **Read sync, OAuth flavor — Gmail** (15-min cadence). Validates the token-refresh + expiry path. Calendar in 2e will share these tokens (same Google scopes), so the secrets layout needs to anticipate scope-sharing now or pay migration cost later.
   - **Read sync, API-key flavor — Lunch Money** (daily cadence). Validates the simpler static-credential path and bulk import.
   - **Long-lived gateway — Discord bot.** Ports the v1 allowlist (specific user + guild + DM). Replies route through Phase 2d's new `outbound-policy.js` (PII / secret / untrusted-content guards), not a new policy.
3. **Schema migration 0006.** Concrete fields: per-integration cursor `runtime:scheduler.integrations.<name> = { cadence_ms, next_run_at, in_flight, last_sync_at, last_sync_ok, last_sync_error, last_sync_count, consecutive_failures, cursor }`, plus a unique index on `events` for `(source, external_id)` to enforce idempotency at write time. Index is the dedupe mechanism — "don't re-import message_id X" is a constraint violation, not a SELECT-then-INSERT race.
4. **Per-integration in-flight flags.** Phase 2c's scheduler has a single global `inFlight`. 2d replaces that with per-cursor flags so a slow Gmail sync doesn't block Lunch Money. Discord doesn't use the cursor at all — it boots once with the daemon.
5. **CLI auth flows** — `robin auth gmail` opens a browser-callback flow on a localhost loopback port (Node `http.createServer` + PKCE; no `googleapis` SDK dep). `robin auth lunch_money` and `robin auth discord` are non-interactive prompts that just write the JSON. Plus introspection: `robin integrations list/run <name>/status`.

**Embedding-cost note.** Every captured row goes into `events` with a 384-dim HNSW embedding. Gmail at 15-min cadence is fine. Discord gateway can flood (a busy guild produces hundreds of messages per minute). Mitigation declared here: the framework supports an `embed: false` path on the manifest so high-volume sources skip embedding at capture time. The biographer/dream pipeline still works on these — it just can't HNSW-search them. Acceptable for chat noise.

**Not in 2d:** calendar, drive, github (write), spotify (write), weather, ebird, chrome, youtube, whoop, lrc, linear, nhl, photos, ga. Each is a small follow-on. Calendar will reuse Gmail's OAuth tokens; github-write and spotify-write will reuse the Discord bot's outbound-policy wiring.

## 2. Framework SDK

Each integration is a directory with three required exports.

### Manifest

```js
// src/integrations/gmail/manifest.js
import { createGmailSearchTool } from './tools/gmail-search.js';
import { createGmailGetThreadTool } from './tools/gmail-get-thread.js';

export const manifest = {
  name: 'gmail',
  cadence: '15m',                    // null for gateway integrations
  embed: true,                       // false skips HNSW embedding at capture
  capture_mode: 'insert-or-skip',    // or 'upsert' (Lunch Money uses upsert for edits)
  auth: {
    kind: 'oauth2-google',           // 'oauth2-google' | 'api-key' | 'discord-bot'
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  tools: [createGmailSearchTool, createGmailGetThreadTool],   // factories, not names
};
```

`cadence` parser accepts `<n>m`, `<n>h`, `<n>d` (no compound forms — `15m30s` is rejected at boot). Numbers in ms also accepted. Negatives and zero rejected. No `version` field — manifest-format changes are framework concerns. No separate `secrets.schema` — the auth helper for each `auth.kind` knows what fields to interrogate.

### Sync function

```js
// src/integrations/gmail/sync.js
export async function sync(ctx) {
  // ctx exposes only what sync should touch:
  //   - secrets: auto-refreshed if expired; helper persists back to disk before sync starts
  //   - log: structured logger
  //   - cursor: opaque object the integration owns (last history_id for gmail, last txn_id for lunch_money)
  //   - capture(rows): framework writer (dedup + embed + insert into events with source/external_id index)
  //   - signal: AbortSignal — pass to fetch() and similar
  //
  // Return: { count, cursor } — framework persists `cursor` for the next run
  // and stamps `last_sync_at`, `last_sync_count`, clears `consecutive_failures` on scheduled runs.
}
```

`db` is intentionally not on `ctx` — sync writes go through `capture()` and cursor lives on `ctx`. YAGNI for now.

`cursor` is whatever shape the integration wants. Gmail returns `{ history_id }`, Lunch Money returns `{ start_date }`. Framework persists it as JSON in the runtime row and feeds it back next run.

### Tools

Per-integration MCP tools live at `src/integrations/<name>/tools/<tool>.js`. Same factory shape as Phase 2c (`createGmailSearchTool({ db, secrets, signal })`). Manifest re-exports the factories; daemon registers them. Tool-factory failures log per-tool but don't break the integration's sync.

### Auth helpers

Three reusable modules in `src/integrations/_auth/`:

- `oauth2-google.js` — PKCE flow on a localhost loopback port (Node `http.createServer`, no `googleapis` SDK). Refresh-token persistence. Reused by 2e Calendar/Drive/YouTube — same Google scopes share one token file. **Known limitation:** loopback flow assumes a local browser. Headless fallback ships in 2d via `--code <code>` flag (paste auth code from manually-opened URL). Full device-flow polish deferred to 2e.
- `api-key.js` — interactive prompt + validates against a test endpoint.
- `discord-bot.js` — prompts for bot token + allowlisted user/guild IDs; validates via REST `GET /users/@me` (no gateway connection at validation time).

Each writes `~/.robin/secrets/<name>.json` with `0600` perms.

### Discovery and lifecycle

Daemon at boot reads `src/integrations/*/manifest.js`. Each manifest is loaded in a try/catch — a broken integration logs a warning and is unloaded, but the daemon stays up.

1. **Scheduled integrations** (`cadence !== null`): registers `runtime:scheduler.integrations.<name>` with the field set above. The Phase 2c heartbeat tick iterates all cursors and fires `sync()` per past-due integration. Per-integration `in_flight` prevents concurrent runs of the same sync. **Daemon-boot cleanup:** any `in_flight: true` rows from a prior crashed daemon get reset to `false` on boot.
2. **Gateway integrations** (`cadence === null`): calls `start(ctx)` once at daemon boot. Bot owns its own connection lifecycle.
3. **Tools**: appended to MCP registry.

**Shared sync helper.** Scheduler and `integration_run` MCP tool both call a single `runIntegrationSync(name, { manual })` helper that owns the in-flight flag, last_sync_* writes, and conditional backoff increment. Logs trigger source ("manual sync started by tool" vs "scheduled tick fired sync") in its first log line.

**Shutdown.** The daemon's SIGTERM/SIGINT handler aborts all in-flight `signal`s, calls `stop(ctx)` on gateway integrations, and waits up to **10s total** for everything to settle before forcing exit. This also addresses Phase 2c's known issue (scheduler.stop() didn't await). Same 10s grace covers in-flight `sync()` runs.

**Failure handling (scheduled runs).** A thrown `sync()` is caught, logged, written to `last_sync_error`, and `consecutive_failures += 1`. Backoff: 3+ consecutive failures double the effective cadence (capped at 24h). The next success resets failures to 0 and restores the manifest cadence.

**Failure handling (manual runs).** Stamps `last_sync_at`, `last_sync_error`, `last_sync_ok = false`. **`consecutive_failures` is unchanged** by manual runs — only scheduled runs feed the backoff.

## 3. The three reference integrations

### Gmail (read sync, OAuth)

- **Cadence:** 15m. **Embed:** true. **Capture mode:** `insert-or-skip`.
- **Cursor:** `{ history_id }` from the Gmail History API. **First sync:** `messages.list?q=newer_than:7d` paged at 100 per call, hard-capped at **500 messages total** to avoid quota bursts on heavy mailboxes. **Subsequent runs:** `users.history.list?startHistoryId=<saved>`. **Expiry fallback:** Gmail rejects history_ids older than ~7 days with 404/410 — on that error the integration discards the cursor and re-runs the first-sync path.
- **Label filter:** skip `TRASH`, `SPAM`, `CATEGORY_PROMOTIONS` by default. Configurable via `manifest.config.gmail.skip_labels` if the user wants to override.
- **What captures:** `subject + from + <Gmail's own snippet field>` as `content`. `meta = { gmail_id, thread_id, labels, internal_date }`. Top-level `external_id = gmail_id`. Full body NOT captured — privacy + token cost. Agents pull bodies on demand via `gmail_get_thread`.
- **MCP tools:** `gmail_search(query)` and `gmail_get_thread(thread_id)` — both hit live API.
- **Auth + token refresh:** the helper checks `expires_at` before sync starts AND retries once on a 401 from any API call within the sync run.

### Lunch Money (read sync, API key)

- **Cadence:** 24h. **Embed:** true. **Capture mode:** `upsert` (catches edits to existing transactions).
- **Cursor:** `{ start_date: 'YYYY-MM-DD' }`. The Lunch Money API doesn't expose an `updated_at` filter — only `start_date`/`end_date`. Sync uses a rolling window: `start_date = max(saved_cursor, today − 14d)`, `end_date = today`. Newer cursor stored is `today`.
- **What captures:** one event per transaction. `content = "<payee> · $<amount> · <category>"`. `meta = { lm_id, account_id, payee, amount, currency, category, date, status, plaid_account_id? }`. Top-level `external_id = lm_id`.
- **MCP tools:** `lunch_money_query({ since?, until?, payee_contains?, min_amount?, category? })` — DB-backed with curated filters. No `surql` passthrough (untrusted-input → query-injection risk).

### Discord bot (gateway, in-process)

- **Library:** `discord.js` v14, pinned at v14 in package.json. (~1.5MB minified, peer deps included; matches v1, well-maintained.)
- **Cadence:** null. **Embed:** false. (HNSW search won't find Discord messages — agents use `list_journal` + metadata filters.)
- **Allowlist:** `{ user_id, guild_id }` from `~/.robin/secrets/discord.json`. Enforced via a **single dispatcher** wrapping `messageCreate` and `interactionCreate` — every event runs through the same allowlist check before routing. Non-allowlisted events are dropped at the dispatcher and never written.
- **What captures:** allowlisted DMs, allowlisted-guild @mentions, slash-command invocations. Allowlisted-guild messages that aren't mentions or slash commands are NOT captured (matches v1). `content` is message text. `meta = { discord_message_id, channel_id, guild_id, author_id, kind: 'dm'|'mention'|'slash' }`. Top-level `external_id = discord_message_id`.
- **Slash commands `/new`, `/cancel`, `/help`:** registered **once** at first daemon boot after auth, via REST `PUT /applications/<id>/guilds/<guild_id>/commands`. Idempotent; subsequent boots check a `runtime:integrations.discord.commands_registered_at` row and skip if present. Re-registration also exposed as `robin integrations discord register-commands`.
- **Replies = LLM call.** Bot doesn't compose replies itself. On a triggering message it calls the daemon's `host.invokeLLM` (same adapter Phase 2c uses) to draft a reply, then sends it. Reply text passes through `outbound-policy.js` before sending.
- **Lifecycle:** `start(ctx)` registers slash commands if needed, opens gateway, attaches dispatcher. `stop(ctx)` calls `client.destroy()` and resolves; framework's 10s shutdown grace covers it.
- **MCP tools:** none in 2d. (Future `discord_send` for outbound triggered by agent in 2e.)

## 4. Schema migration 0006 + capture API + outbound policy

### Migration 0006

```surql
-- 0006-integrations.surql

-- Promote external_id to a top-level field for indexable uniqueness.
DEFINE FIELD external_id ON events TYPE option<string>;
DEFINE INDEX events_source_external ON events FIELDS source, external_id UNIQUE;

-- Trust marker for outbound policy untrusted-quote check.
DEFINE FIELD trust ON events TYPE string DEFAULT 'trusted'
  ASSERT $value IN ['trusted', 'untrusted', 'untrusted-mixed'];

-- Relax embedding to option<>. Phase 2d skips embedding for high-volume sources
-- (manifest.embed = false) AND falls back to NULL on transformers cold-start failure.
REMOVE FIELD embedding ON events;
DEFINE FIELD embedding ON events TYPE option<array<float>>
  ASSERT $value IS NONE OR array::len($value) = 384;

-- Outbound refusals get a real table with a created_at index for TTL pruning.
DEFINE TABLE outbound_refusals SCHEMAFULL TYPE NORMAL;
DEFINE FIELD destination ON outbound_refusals TYPE string;
DEFINE FIELD reason      ON outbound_refusals TYPE string;
DEFINE FIELD payload_hash ON outbound_refusals TYPE string;
DEFINE FIELD created_at  ON outbound_refusals TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX outbound_refusals_created ON outbound_refusals FIELDS created_at;

-- Per-integration runtime row uses runtime:scheduler.integrations.<name> (FLEXIBLE)
-- with fields: cadence_ms, next_run_at, in_flight, last_sync_at, last_sync_ok,
-- last_sync_error, last_sync_count, consecutive_failures, cursor.
```

### Deterministic event IDs

Phase 2d uses Phase 2a's stable-ID pattern: `events:<source>__<sanitized_external_id>` (double-underscore, external_id `[a-zA-Z0-9_-]+` only — anything else hashed). Keys collide deterministically, so UPSERT on the explicit ID works without a SELECT round-trip.

### `ctx.capture(rows)` API

```js
// mode comes from the manifest's capture_mode, not per-call
await ctx.capture([
  {
    source: 'gmail',
    content: 'Subject: ... | From: ...',
    ts: new Date('2026-05-09T...'),
    external_id: 'abc123',
    trust: 'trusted',                     // optional, defaults to 'trusted'
    meta: { gmail_id: 'abc123', thread_id: '...', labels: [...] },
  },
  // ...
]);
```

- **Embedding:** controlled by manifest's `embed` flag, not per-row. Skipped rows get NULL embedding; HNSW ignores them. Cold-start transformer failure falls back to NULL with a logged warning rather than dropping the capture.
- **Dedup:** for `mode: 'insert-or-skip'` — per-row `IF NOT EXISTS` SELECT-then-CREATE. For `mode: 'upsert'` — UPSERT on the deterministic ID with MERGE.
- **Returns:** `{ inserted, skipped, updated, errors }`.

### Outbound policy

`src/outbound/policy.js` — port from v1 `system/scripts/lib/outbound-policy.js`:

- **PII patterns** (SSN, full credit-card, full SIN, full passport) — block.
- **Secret patterns** (env-var values, API key shapes, OAuth tokens) — block.
- **Untrusted-quote guard:** reply text must not include verbatim phrases (≥10 consecutive words) from any `events.trust IN ['untrusted', 'untrusted-mixed']` row in the **last 7 days**. The 7-day bound prevents the check from scaling with total event count.
- **No rate-limit module in 2d.** Discord bot replies are gated only by allowlist + LLM cost. Adding rate-limit accounting deferred to 2e.
- Returns `{ ok: true } | { ok: false, reason: '...' }`. Refusals append a row to `outbound_refusals` (`reason`, `destination`, `payload_hash` only — never the full payload).

Single module reused by Discord bot replies (now) and github/spotify writes (2e+).

**Outbound-policy clarifying note:** outbound-policy gates user-visible WRITES (Discord replies, future github-issue creation, future spotify-playlist edits). API READS (Gmail, Lunch Money) don't go through it — they're inbound data flows.

## 5. CLI + MCP surface + AGENTS.md

### CLI commands (new in 2d)

```
robin auth gmail                    # OAuth loopback browser flow (--code <code> for headless paste)
robin auth lunch_money              # API-key prompt + /me validation
robin auth discord                  # bot token + user_id + guild_id, /users/@me validation

robin integrations list             # name, cadence, last_sync_at, last_sync_ok per integration
robin integrations status <name>    # full health + cursor + recent errors for one (--json optional)
robin integrations run <name>       # trigger sync inline (refuses if daemon running)
robin integrations discord register-commands   # one-off slash command re-registration
```

**Daemon coordination.** `list` and `status` open the DB read-only — work whether the daemon is running or not. `run` is a write path and refuses while the daemon is running. `discord register-commands` doesn't touch the DB; refuses while daemon is running because the daemon owns the DB write.

**Re-auth handling.** If `~/.robin/secrets/<name>.json` already exists, the CLI prompts: keep / overwrite / merge (Discord allowlist only — adds user/guild IDs to the existing list). On successful re-auth, the corresponding `runtime:integrations.<name>.commands_registered_at` is cleared so re-registration runs on next sync.

**`integrations status` output.** Plain-text by default, `--json` for machine-readable.

### MCP tools (new in 2d)

| Tool | Wraps | Live or DB-backed |
|---|---|---|
| `gmail_search(query)` | live API call | Live |
| `gmail_get_thread(thread_id)` | live API call | Live |
| `lunch_money_query({ since?, until?, payee_contains?, min_amount?, category? })` | curated SurrealQL on `events` | DB |
| `integration_status(name?)` | runtime row(s); `name` omitted → all | DB |
| `integration_run(name)` | invokes shared `runIntegrationSync(name, { manual: true })` | Live + DB write |

Total daemon surface: 19 → **24**.

### `integration_run` semantics

- **Pre-checks:** name exists; `cadence !== null` (gateway integrations refuse); not currently in-flight.
- **Successful invocation when nothing else is running:** the tool calls `runIntegrationSync(name, { manual: true })` and awaits it. Returns `{ ok: true, count, cursor, duration_ms }` once the sync completes.
- **Concurrent-call:** if another invocation (scheduled or manual) is already in-flight, return immediately with `{ ok: false, reason: 'in_flight', started_at: <ts> }`. Agent that needs the result polls `integration_status`.
- **Min-interval guard:** hard 30-second floor. Refuses with `{ ok: false, reason: 'too_recent', wait_seconds: N }` if last_sync_at was <30s ago.
- **MCP timeout:** sync runs that exceed Claude Code's MCP-tool wall-clock timeout will surface as tool-timeout errors to the agent. The framework still completes the sync in the background.
- **Backoff:** manual triggers do NOT increment `consecutive_failures` on failure. Failures still log to `last_sync_error` and stamp `last_sync_at`, `last_sync_ok = false`.

**Live-tool token freshness.** `createGmailSearchTool` and `createGmailGetThreadTool` read `~/.robin/secrets/gmail.json` on **every call** (~100µs file read), so a re-auth picks up immediately without daemon restart.

**Cursor exposure caveat.** `integration_status` returns the opaque cursor object — implementation detail leaking to agents; acceptable for personal v2.

### AGENTS.md updates

Two new sections, **inside their own nested fence** so the auto-generated parts can be regenerated without disturbing manual edits:

```markdown
<!-- robin-integrations:start (auto-generated, do not hand-edit) -->
## Integration data freshness

Before quoting integration data as "today's" / "current" / "latest", call
integration_status({name}) and verify last_sync_at is within 2× the cadence.
If stale, either label the quote as "data from <last_sync_at>" OR call
integration_run({name}) to refresh.

After integration_run, the result IS immediate when no concurrent sync is
running — the tool awaits and returns count/cursor/duration_ms. If it returns
{ ok: false, reason: 'in_flight' }, poll integration_status({name}) every 2s
(don't poll faster); when in_flight flips to false, check last_sync_at and
last_sync_ok. Don't loop more than ~30 polls (~60s) — surface "sync taking
unusually long" if it exceeds that.

Don't fabricate fresh data. Don't loop on integration_run — the 30s
min-interval will refuse, and repeated polling burns API quota.

## Available integrations

- gmail (15m): gmail_search, gmail_get_thread
- lunch_money (24h): lunch_money_query
- discord (gateway): bot listens on allowlist; no agent-callable tools
<!-- robin-integrations:end -->
```

The `<!-- robin-integrations:start/end -->` block is regenerated on every successful `robin auth <name>` and on `robin install`. Manual content outside the block is preserved by the fenced-merge logic from Phase 2b.

## 6. Testing strategy + open questions + success criteria

### Testing strategy

**Mocking approach:** all live HTTP APIs stubbed via Node's built-in `mock.method(globalThis, 'fetch', stub)` — no `nock` or `msw` dep. Time-sensitive tests use `mock.timers`. discord.js Client is mocked at the surface the dispatcher uses (`login`, `on('messageCreate')`, `on('interactionCreate')`, `destroy`); fixture file at `tests/fixtures/discord-events.js` provides Message/Interaction objects.

**Unit-level** (mem://, deterministic):
- Manifest loader: rejects malformed manifests, parses cadence strings, surfaces tool factories.
- Cadence parser: `'15m'` → 900_000ms, `'1h'`, `'1d'`, raw integer ms, rejects `'15m30s'`, rejects negatives, rejects 0.
- `ctx.capture()`: insert-or-skip dedup, upsert path, NULL embedding fallback, error-collection.
- Outbound policy: PII / secret / untrusted-quote rules. Untrusted-quote test uses `mock.timers` to advance fake clock so events seeded with `trust='untrusted'` cross the 7d boundary mid-test.
- Per-integration cursor advancement.
- Backoff: 3 consecutive scheduled-failures double cadence; success resets.
- Auth helpers: `oauth2-google` PKCE state generation + token-refresh path with mocked fetch; `api-key` validation; `discord-bot` `/users/@me` flow.
- Daemon-boot cleanup: stale `in_flight: true` rows reset to `false` on boot.
- `integration_run` min-interval guard, gateway-integration refusal, success path, in-flight concurrent path.

**Integration-level** (mem:// + mocked fetch):
- Gmail full sync (first-sync + history-id-delta + history-id expiry fallback).
- Lunch Money rolling window with upsert handling edits.
- Discord bot dispatcher (allowlisted DM, mention, slash + non-allowlisted drop).
- Outbound policy live path: bot reply with credit-card → blocked; with recent untrusted quote → blocked; clean → sent.
- Scheduler heartbeat with multiple integrations, different cadences, no cross-blocking.
- `integration_run` end-to-end: tool handler invoked → shared helper runs sync → events written → `integration_status` reflects updated row.
- Backoff isolation: scheduled failure increments `consecutive_failures`; manual failure does not.
- Migration safety: all 251 Phase 2c tests still pass after migration 0006. Bootstrap test asserts 6 migrations.

**Manual smoke before tagging:**
- Real Gmail OAuth round-trip with `--max-rows 50` first-sync override.
- Real Discord bot connect to a personal test guild, slash commands register, reply with policy guard.
- Real Lunch Money pull with `--since YYYY-MM-DD` (recent week).

### Open questions / known limitations

| # | Item | Resolution |
|---|---|---|
| 1 | Headless OAuth fallback for VM | `--code <code>` flag in 2d; full device-flow polish in 2e |
| 2 | Untrusted-quote guard limited to last 7d | Documented trade-off; revisit if attack surface grows |
| 3 | No rate limiter for outbound | Rely on Discord's own; revisit if bot misbehaves |
| 4 | Discord embedding skipped (no HNSW search) | Acceptable for chat noise; agents use `list_journal` + meta filters |
| 5 | Gmail body NOT captured | Privacy + token cost; agents fetch on demand via `gmail_get_thread` |
| 6 | First-sync hard cap of 500 Gmail messages | Avoids quota burst; older messages remain unseen unless user manually triggers a wider initial sync |
| 7 | OAuth scope sharing for Calendar/Drive (2e) | Each integration writes its own file in 2d; Calendar/Drive in 2e introduce shared `google.json` and migrate Gmail's secrets at install time |
| 8 | Slash command registration is guild-scoped | Faster propagation than global; multi-guild needs manual re-register |
| 9 | discord.js dep weight (~1.5MB + peers) | Acceptable for personal use |
| 10 | Live re-auth requires daemon restart | `robin auth gmail` while daemon running refuses (Phase 2c CLI pattern). Live-reload deferred to 2e. |
| 11 | discord.js Client mock fixtures | Pinned to v14; mock fixtures need updates if v14 → v15 changes shapes |

### Success criteria for v6.0.0-alpha.5

- Migration 0006 applies cleanly on top of 0005; all 251 Phase 2c tests still pass with the relaxed embedding schema.
- All three integrations sync successfully against real APIs (manual smoke).
- Daemon boots with all three integrations registered; heartbeat fires Gmail at 15m and Lunch Money daily; Discord gateway connects; daemon-boot in_flight cleanup runs.
- 24 MCP tools registered; `integration_status` and `integration_run` return valid output; agent can call `gmail_search` and get live results.
- Outbound policy blocks at least one synthetic credit-card and one synthetic untrusted-quote in tests.
- AGENTS.md auto-section regenerates correctly after `robin auth gmail` re-auth without disturbing manual content outside the fence.
- `npm test` passes (target: ~285 tests, +34 from 2c). `npm run lint` clean.
- CHANGELOG entry + `v6.0.0-alpha.5` tag.
