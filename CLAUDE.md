# CLAUDE.md — robin-assistant

## Architecture

Robin is a local-first personal AI assistant. Three layers:

```
system/       ← framework: kernel (daemon + scheduler), brain (memory +
                cognition), integrations runtime, surfaces (CLI, HTTP, MCP)
user-data/    ← per-user instance data (gitignored): memory, secrets,
                extensions, jobs, knowledge files
dist/         ← compiled output (gitignored); `pnpm build` to regenerate
```

Runtime: Node.js 24+, ESM, TypeScript. Database: SQLite (better-sqlite3 +
sqlite-vec). Package manager: pnpm.

## Commands

```bash
pnpm install                # install deps
pnpm build                  # tsc + build extensions → dist/
pnpm test                   # node --test across system/
pnpm lint                   # biome lint
pnpm typecheck              # tsc --noEmit
pnpm exec tsx --test <file> # single test
```

Daemon: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`

## Memory & user-data

`user-data/content/knowledge/` is Robin's memory store. Prefer it over Claude
Code's memory system for cross-session context — Robin IS the memory system.

`user-data/` is for **personal data only** (life, preferences, health, finance,
career, creative work) — not dev artifacts (bugs, branches, packages, configs).
The biographer's `BLOCKED_ENTITY_TYPES` in `system/brain/cognition/biographer.ts`
enforces this; add new engineering entity types there.

Raw event notes live in `user-data/content/sources/notes/<slug>.md` (never indexed, never
published); `/note compile <slug>` writes the compiled doc to `content/knowledge/events/`.

## Recommendations & the action loop

When you give the operator a **substantive recommendation** — a buy/skip/try/wait/avoid
stance on a specific named thing (gear, a place, a tool, a decision) — log it with
the `recommend` MCP tool, the same discipline as logging a `predict`. The nightly
`recommendation-link.run` linker then detects whether they act on it; a weekly
`recommendation-scan.run` LLM pass backfills recommendations you forget to log. This
feeds calibration (which advice lands) and the behavioral habit engine. Inspect with
`robin recommendations` and `robin habits`.

Loop rules (2026-10-03): the linker also reads order/shipping/booking emails and
shipments, matching the rec subject's distinctive tokens *inside* the email text;
the weekly scan adds a `classify` pass judging open recs against signals + the
operator's own session turns. skip/avoid/wait recs resolve `held` at expiry (a matching action
is contrary → `declined`) and stay out of the acted-rate. `recommend` supersedes an
open rec with an overlapping subject and caps 15 new recs per session per day —
the excess is stored `suppressed`. One-time cleanup: `robin recommendations dedupe
[--apply]`.

## Secrets

Secrets live in `user-data/config/secrets/.env` (gitignored). **Every process
entry point must call `loadEnvFile(userData)` before running integrations** —
daemon, both MCP servers, and standalone scripts. Forgetting this is a silent
failure (integration skips with "not set"). OAuth tokens rotate; use
`robin reauth <integration>` to refresh.

## Notifications

One fan-out, `notifyOperator()` in `system/lib/notify/operator.ts`: a macOS
banner (`notify` builtin) **and** a Discord ping (`discord` builtin), attempted
in parallel, neither able to throw or suppress the other. All three operational
callers go through it — health-monitor critical invariants, sky/sunset alerts
(`lib/sky/deliver.ts`), and agent-paused/exhaustion notices (`agent/notify.ts`).

The Discord side is **outbound REST only** — `POST /channels/{id}/messages` with
`Authorization: Bot …`. No gateway connection, no `discord.js` (~250 MB), no
launchd service; the bot reads as offline in the sidebar and still delivers. Robin talks, it
doesn't listen: two-way chat would need a gateway process, a separate decision.

Two channels, two env vars: `DISCORD_NOTIFY_CHANNEL_ID` (alerts) and
`DISCORD_BRIEF_CHANNEL_ID` (long documents such as a daily brief).
`DISCORD_ALLOWED_USER_IDS`'s first id is the operator — mentioned by default on
channel posts, and the recipient for `dm`. Without a token the whole Discord
side no-ops quietly and the macOS banner still fires.

**Message flags.** `silent: true` → `SUPPRESS_NOTIFICATIONS` (4096): lands with
an unread mark, no push, no sound. Anything scheduled outside waking hours must
set it; `digest` defaults to it. `SUPPRESS_EMBEDS` (4) is **on by default
everywhere** — a long digest can carry dozens of links and each would otherwise unfurl into a
preview card. Opt back in with `suppressEmbeds: false`. A silent digest posts
with `flags: 4100`.

**Long documents** go through `digest`, which splits on blank-line boundaries
into ≤2000-char messages and posts them **consecutively in the channel** — not
in a thread. Discord renders
no markdown tables, so `mdTablesToDiscord()` rewrites every `|`-table first: an
aligned monospace code block when the table is narrow (≤56 cols) and link-free
— which keeps balance columns scannable — and one bullet per row otherwise,
since a code block would swallow the markdown links.

**Gotcha:** Discord bounces a generic User-Agent at the Cloudflare edge with a
bare `error code: 1010` that reads like an auth failure. The UA must be shaped
`DiscordBot ($url, $version)`. Ad-hoc `curl` works; `python3 urllib` does not.

Every message passes `checkOutbound()` before it leaves the process, so a
credential or PII shape is refused rather than posted. Ad-hoc pings: the
`discord` MCP tool (`notify` | `dm` | `digest`) on `robin mcp extension`.

## Agentic execution

Agentic `query()` is allowed **only** through `system/agent/runAgent` — ledger-
accounted, tool-allowlisted, turn/time/budget-capped, worktree-isolated for
writes, OS-level sandboxed (seatbelt/bubblewrap), JSONL-transcribed. Direct
`claude -p` shell-outs are banned. For non-agentic LLM work, use
`llm.invoke(role, …)` through the dispatcher.

**Auto-fix loop.** The 4:00am `reliability-audit.run` turns its findings
(needs-human, recurring repairs, stale integrations, flags) into a remediation
request (`state/runtime/remediation-request.json`); the agent runner's next tick
dispatches K with it ahead of the round-robin. The request survives until K
completes a run on it (a backlog skip or failed run is retried, max 3 attempts). A verified K branch auto-lands
via `system/agent/auto-land.ts` only if it clears every gate:
- scope: reliability code only — `system/kernel/invariants/`, the health
  monitor and its helpers in `system/kernel/runtime/`, `system/kernel/scheduler/`,
  `system/integrations/_runtime/`, `system/jobs/_runtime/` (operator decision
  2026-10-31: everything else goes to review); and never the agent runtime's
  computed import graph, nor
  `surfaces/`, `kernel/config/`, `scripts/`, secrets, capture,
  publish/discretion/notify, the reliability audit, or migrations;
- size and proof: ≤8 files / ≤400 lines, includes a test, no commits ahead of
  main, no overlap with uncommitted work in the live checkout;
- reach: no new network/subprocess/secrets/dynamic-code access, stdout/exit
  tampering or node:v8 in any file; no NEW process/globalThis/Reflect/console
  internals, eval/Function, env assignment, /dev paths or numeric-fd writes
  (exact contexts, comment-stripped whole file vs HEAD); only regular files
  (no symlinks/gitlinks); unreadable changed files hold; and
  no env/URL access or new imports in non-test code;
- loosening (`weakeningViolation`): no raised threshold, downgraded severity or
  early pass in check code, no dropped invariant, no removed/rewritten/skipped
  assertion;
- verify: typecheck + lint + the full suite pass inside a seatbelt sandbox
  (`gateSandboxProfile` + `gateEnv`): reads deny-by-default (toolchain,
  worktree, repo node_modules, a private temp dir), TCP loopback only minus
  ports already listening, no DNS; writes to the worktree (not its `.git`), the
  private dir and NEW /tmp entries only (never reserved names like `tsx-*`);
  exec allowlist (shells, node, CLT git, inert utilities, node_modules — no
  interpreters, launchctl, osascript, open, security); native code mapped only
  from system paths and node_modules; app/keychain/clipboard services denied;
  fake HOME, no shared caches, no pnpm. The base's sandbox failures are taken
  first (before any K code runs, own private dir); candidate failures come from
  node:test's JUnit report (the runner's stdout — test output can't reach it)
  keyed `file :: suite > name` — untouched test files must run exactly the
  base's cases (inventory cross-check), exit status must agree with the
  report, and only NEW failures hold,
  and failures in files the diff touches are never excused.
  The `.git` pointer must target the repo's worktree admin dir, and worktree
  git runs with hooks/fsmonitor/signing off. The worktree must be unchanged
  afterwards. No sandbox (non-macOS) means nothing lands.

Then: commit, merge into main, `pnpm build` (a failed build reverts the merge),
daemon restart, and a 150s probation (`land-probation.ts`) that reverts if the
daemon isn't up and settled. Every land/hold/probation goes to
`state/runtime/auto-land-log.jsonl` (the audit shows K the last 7 days) plus a
silent Discord note. Anything else stays a review branch.
Limit: this is static analysis of LLM-authored JS — it narrows the ways out,
it can't prove there are none, and landed code runs unsandboxed in the daemon.
Kill switch: `agent.auto_land: false`. Gap: user-data extensions are gitignored,
so K can't fix them.

## Personal data never goes in tracked files

This repo is **public**, and sessions here see the operator's real data constantly
(auto-recall, the primer, the live DB). Every past leak was a real value **copied out
of memory** into a regression test, fixture, or comment — a phone number, a medication,
an account suffix, a friend's name. So:

- **Never copy a value from memory, recall, the DB, or `user-data/` into code, tests,
  comments, docs, or commit messages.** Reproduce a bug with fictional data that has
  the same shape (people "Sam Rivera"/"Nora", org "Acme", phone `555-0142`, card
  `⋯1234`, drug "examplamide"). Describe the incident, not the person.
- **Invent, don't rename.** Swapping a name but keeping the real numbers, dates,
  thresholds, kit list or project layout is still a leak (a real balance under a fake
  bank name, a real kit list renamed one-to-one). Pick values from an
  unrelated domain — cycling, baking, knitting — not the operator's own hobbies,
  metrics, gear, trips or businesses.
- Personal values the code needs at runtime come from `system/lib/operator-profile.ts`
  (gitignored `user-data/config/operator.yaml`); degrade gracefully when absent.
- **Enforced, don't bypass:** `githooks/pre-commit` refuses staged personal data and a
  personal commit identity; `githooks/pre-push` re-checks every pushed commit, its message
  and author (`system/scripts/private-scan.mjs`: operator.yaml terms + the people,
  medications and accounts in Robin's memory + deployment hostnames from the secrets
  file + phone/mailbox/last-4 shapes + any added
  line sharing a 6-word run with the operator's notes, corrections or beliefs). Never
  `--no-verify` past a refusal — fix the fixture. Commit with the repo-local noreply
  identity; never pass `-c user.email=…`.
- Audit the whole tree any time: `node system/scripts/private-scan.mjs --tracked --deep`.

## Code conventions

- Match surrounding style. Tests collocated: `foo.ts` → `foo.test.ts` (`node:test` + `assert`).
- Integrations: `system/integrations/builtin/<name>/` (shipped) or
  `user-data/extensions/integrations/<name>/` (per-user, gitignored).
  Each has `integration.yaml` + `index.ts` with `tick()` and optional MCP `actions`.
- `pnpm build` compiles user-data extensions in-place (`.ts` → `.js` alongside).
- Integration ticks run inside 120s `withTimeout`. Cognition jobs and user jobs
  are bounded by per-LLM-call timeouts and SDK `timeoutMs`, not a scheduler cap.

## MCP servers

Two stdio MCP servers (configured in `.mcp.json`):

- `robin mcp core` — memory read/write: list, recall, remember, believe, predict, etc.
- `robin mcp extension` — integration actions, run, update, chrome, finance, gmail, etc.

Plus one HTTP surface for clients Robin doesn't run:

- `robin mcp remote [--port N]` — core over Streamable HTTP at `/mcp`, for
  claude.ai custom connectors. Two scopes, chosen on the consent screen:
  `robin:read` serves `READ_ONLY_TOOLS` (15), `robin:write` adds
  `REMOTE_WRITE_TOOLS` (6 memory-ledger writes). Both lists live in
  `system/surfaces/mcp/core/server.ts`; a tool reaches the remote surface only by
  being named there, so new tools are local-only by default. `readOnly: true` is
  set even for write grants — it disarms the write branch of mixed tools (`get`
  upserting, `alerts` ack, `power` mutations), which are never remote. Never
  remote at all: `agent`, `run`, `update`, `ingest`. Binds loopback — public
  reach requires a deliberate tunnel (`user-data/scripts/setup-mcp-tunnel.sh`).

  Auth is **OAuth 2.1**, not a URL secret: claude.ai's connector validator
  rejects a URL whose path carries a long high-entropy token (verified 2026-08-08
  — an identical server connected at `/mcp` and failed at `/t/<43-char>/mcp`).
  The server is its own authorization server — RFC 9728 protected-resource
  metadata, RFC 8414 metadata, RFC 7591 dynamic client registration, S256 PKCE,
  rotating refresh tokens (`system/surfaces/mcp/remote/oauth/`, migration 032).
  `ROBIN_MCP_REMOTE_TOKEN` is now the **consent-screen access key**, entered in
  the browser during the OAuth flow — it is never sent to Claude.
  `ROBIN_MCP_PUBLIC_URL` must be the public origin, since OAuth metadata
  advertises absolute URLs. Gotcha: a 401 must carry
  `WWW-Authenticate: Bearer resource_metadata="…"` — Claude ignores that header
  on a 200 — and SSE responses must not be length-delimited.

MCP servers are **separate processes** from the daemon — they don't share
process.env or DB connections. Each must independently call `loadEnvFile()` and
`openDb()`.

## Publish pipeline

Publishable deliverables (guides, reference cards, reports) go to askrobin.io
via `robin publish --source <file> --slug <slug>`.

**Default format: a standalone, designed HTML page.** Write
`user-data/content/knowledge/<sub>/<doc>.html` as a complete document:
- `<title>`, `<meta name="description">`, `<meta name="robin:category">` (same
  taxonomy as frontmatter; missing → Uncategorized). Optional `robin:slug`.
- All CSS inline in one `<style>`: color tokens on `:root`, dark mode under
  `@media (prefers-color-scheme: dark)`, explicit `body` background, works at
  phone width (16px gutter, no horizontal scroll; tables reflow).
- **JavaScript runs, sandboxed.** Inline `<script>`, `on*`
  handlers, and libraries from cdnjs / jsdelivr / unpkg work; local `.js`/`.css`
  files are inlined at publish. The page CSP adds `sandbox allow-scripts` without
  `allow-same-origin`, so each page runs at an opaque origin and can't touch
  askrobin.io cookies, the index, or `/api/*`. Consequences: `localStorage` /
  `sessionStorage` / `indexedDB` / `document.cookie` **throw** (try/catch), no
  `alert`, no `eval`, `fetch` works to any https API (no credentials). Map tiles:
  **Esri ArcGIS** works; OSM/CARTO/Stadia refuse sandboxed requests (no Referer).
  Keep the page's real content in HTML — ingest indexes visible text, not JS output.
- **Web fonts: Google Fonts** — `<link rel="preconnect">` to
  `fonts.googleapis.com` + `fonts.gstatic.com`, then the `css2?family=…&display=swap`
  stylesheet; keep a system-stack fallback. The askrobin CSP allows those two hosts
  and no other cross-origin CSS/fonts — anything else warns at publish and won't load.
- Images: local `<img src="assets/…">` paths upload automatically (PNG/JPEG/WebP,
  no SVG files); diagrams can be inline `<svg>`.
- Attachments: local `<a href="look.xmp">` links (xmp, cube, dcp, lrtemplate,
  gpx, csv, zip, pdf) upload as downloads and keep their filename — markdown too.
- Publish warnings list everything the CSP will block or the sandbox will break —
  read them, fix the source.
- **Discretion gate:** publish refuses credential shapes (incl. inside JS), PII
  shapes, and booking references ("confirmation code XXXXXX") — a record locator +
  surname changes a booking. `--allow-sensitive` only for a verified false positive.
Markdown remains supported (and is still right for knowledge notes that aren't
published).
Ingest indexes `.html` knowledge docs as visible text, so pages stay recallable.

`system/lib/publish/` sanitizes the HTML page (or converts markdown → HTML) → Vercel Blob, served at
`askrobin.io/@<user>/<slug>-<hash10>` — every page URL carries an
unguessability hash (HMAC of `user/slug` keyed by `PUBLISH_URL_SECRET` in
secrets/.env; publish refuses without it). Same slug → same URL on republish.
Markdown links to `/@<user>/<slug>` are auto-hashed at publish time, so source
docs keep plain slugs. The per-user index at `askrobin.io/@<user>/` is
password-gated on the serving side (`PUBLISH_INDEX_PASSWORD` in Vercel env);
pages themselves are unlisted-but-ungated and served `noindex`. The old
private-page system (second blob store, `visibility:` frontmatter) was removed
2026-08-19 — `visibility: private` now refuses. `orchestrate.ts` writes the
page blob and a `users/<userId>/index.json` manifest (`manifest.ts`);
`PUBLISH_USER_ID` sets the publishing identity. Static assets (CSS, JS) live in the
serving app's `apps/web/public/_pub/` (askrobin.io, a separate repo). The template
(`template.ts`) wraps body HTML; `rehype-slug` generates heading IDs for the
external TOC script (`toc.js`). Serving: `proxy.ts` rewrites `/@<user>/...` to
the internal `askrobin.io/apps/web/app/u/[user]/[slug]/route.ts` (page) and
`u/[user]/route.ts` (index); CSP `script-src 'self'`.

**Categories.** Fixed taxonomy in `config.ts CATEGORIES` (10 + `Uncategorized`),
mirrored by `CATEGORY_ORDER` in askrobin.io `apps/web/lib/publish-serve.ts` —
**two repos, nothing enforces the mirror at build time**; adding a category
means editing both (a test in `publish-serve.test.ts` asserts the full list so
drift shows up as a diff). Frontmatter `category:` wins on every publish, so a
source doc without one reverts to Uncategorized next republish — fix the source,
not just the index. Recurring publishers must set it.

**Editing published pages from the index.** The index page has an Edit mode
(delete a page, move it to another category). The local publish log is the
source of truth for the manifest — every publish rebuilds it wholesale — so a
web-side edit would be silently reverted. Instead the web writes an immutable
**pending op** to `users/<user>/pending/<ms>-<op>-<slug>.json`, which
`pending.ts` replays into the local log before every manifest rebuild, then
deletes. An op is dropped as stale if the page was republished after it. Both
consistency traps are handled and both have tests: the manifest read can be
stale (so the whole pending queue is replayed, not one entry edited) and
`list()` is itself eventually consistent (so a just-written op is applied
directly, never read back).

Maintenance without republishing: `robin publish --mode recategorize --slug S
--category C` and `robin publish --mode sync` (fold pending web edits into the
local log now, instead of waiting for the next publish). Bulk taxonomy fixes:
`user-data/scripts/backfill-publish-categories.ts` (`--dry-run` first).
`--mode delete --dry-run` reports without deleting (it used to delete for real).

**Index thumbnails.** The askrobin index shows a page's first photo; pages with
none get a screenshot of the published page (`system/lib/publish/thumbs.ts`):
system Chrome headless + macOS `sips` → `users/<user>/thumbs/<public-slug>.jpg`,
tracked in `thumbs/index.json` (photo pages recorded with `url: ''` so they're
skipped). The CLI captures after every publish and drops the shot on delete;
`robin publish --mode thumbs [--slug S] [--force]` backfills. Retaken only when
`updated_at` changes; no-ops off macOS. The index file is read-modify-written
per publish, so askrobin lists the `thumbs/` folder rather than trusting it.

## Per-user instance

`robin init` for one-time setup. `user-data/` is fully gitignored. Operator-specific
instructions for Claude live in `CLAUDE.local.md` (gitignored, loaded alongside this
file); who the operator is lives in `user-data/config/operator.yaml`.

## Gotchas

- `pnpm exec tsx -e` doesn't support top-level await — use a temp `.ts` file with `async function main()`.
- The `hygiene_review` table no longer exists (dropped by migration 017) — entity
  hygiene actions go through `runHygiene(db)` + `noise_blocklist` and `mergeEntities()`.
- Markdown pages are sanitized (no `<script>`; their JS is the template's `/_pub/*.js`). Standalone HTML pages keep their JS — the serving CSP sandbox is the boundary, not the publisher (see § Publish pipeline).
- A committed `githooks/pre-commit` auto-formats staged files with Biome and re-stages them (non-blocking) — `pnpm install` points `core.hooksPath` at it via the `prepare` script. This is why commits land already-formatted regardless of who makes them (human, assistant, or the daemon's snapshot routine). It only runs `format`, never lint fixes; run `pnpm lint`/`typecheck`/`test` yourself.
- **Event notes (`>>note`).** If `user-data/state/runtime/note-session.json` exists with
  `lastEntryAt` inside the last 6 hours and a prompt arrives that reads as a raw event note,
  the hook missed it (daemon down, or the session id changed). Check the tail of the file named
  in the state JSON first — if the line is already the last entry, reply `📝 #n (already saved)`;
  otherwise append it as `- HH:MM text` (local time) and reply only `📝 #n (by Claude — daemon
  missed it)`. If several lines in a row arrive this way, add "re-run `>>note <slug>`". Never
  ask, never comment on the note.
