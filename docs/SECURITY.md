# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub: [Security → Report a vulnerability](https://github.com/kevinkiklee/robin-assistant/security/advisories/new). Do not open public issues for security problems.

We aim to triage within 7 days.

## Scope

Robin runs locally and stores personal data in `user-data/` (gitignored). Issues worth reporting:

- **Secret leakage** — anything that exposes contents of `user-data/config/secrets/`, OAuth tokens, or API keys in logs, telemetry, error messages, published pages, or external requests
- **Gate bypasses** — a Discord message, published page, or memory write that gets past `checkOutbound()`, the publish discretion gate, or the memory-write check with a credential or PII shape it should have refused
- **Prompt injection** — third-party text (an email, invite, or fetched page) that steers an LLM call or agent run despite the untrusted-content fence
- **Local web exposure** — a web page in your browser reaching the daemon's HTTP port (e.g. by DNS rebinding) or reading memory back from it
- **Agent escapes** — an agentic run writing outside its worktree or sandboxed directory, or running past its turn/time/budget caps
- **Remote MCP auth flaws** — anything that lets a client reach `robin mcp remote` without completing the OAuth flow, or reach tools outside the scope it was granted
- **Path traversal** — code or configs allowing reads/writes outside `user-data/` (or outside the intended subtree, e.g. a skill name resolving to an arbitrary path)

## Out of scope

- Issues that require attacker-controlled access to your machine already (Robin trusts your local UID by design)
- Integration code exceeding its declared `permissions`. The `permissions` block in `integration.yaml` is declarative today: the runtime hands integrations the native `fetch` and does not enforce `network` or `memory.namespaces`. Treat integration code, builtin or user-extension, as trusted code.
- Bugs in upstream dependencies (file with that project; we'll update once they patch)
- Theoretical attacks without a concrete impact path

## Hardening defaults

**Secrets.** Secrets live in `user-data/config/secrets/.env`, which is gitignored (all of `user-data/` is, and so are `.env` files). `loadEnvFile()` (`system/lib/secrets/load-env.ts`) copies it into `process.env` for any key not already set. gitleaks (`.github/workflows/gitleaks.yml`) scans the commits in each push to `main` and each pull request; it does not rescan full history.

**Outbound gate.** `checkOutbound()` (`system/lib/discretion/policy.ts`) refuses text carrying PII shapes (Luhn-valid card numbers, SSN, SIN) or credential shapes (API keys and tokens from common providers, env-var assignments). Every Discord message — `notify`, `dm`, and `digest` — passes it before it is sent, and integrations get it as `ctx.checkOutbound`. (The macOS banner is local and does not.) Captured sessions have credential shapes redacted (`redactSecrets()`) before they are stored or embedded.

**Memory-write check.** The six memory-ledger writes on robin-core (`remember`, `believe`, `predict`, `recommend`, `record_correction`, `resolve_belief_candidate`) run every string argument through `checkInbound()` before anything persists, locally and over the remote surface alike. A credential shape (API keys and tokens, PEM blocks, JWTs, password assignments) is refused with the pattern name, never echoed. The guard wraps the tool at registration, outside the hot-reload dispatcher, so a reloaded callback can't skip it. The generic writes (`remember`, extension `ingest`) also refuse first-party event kinds (`belief.*`, `knowledge.*`, `session.*`, corrections, integration records), so injected text can't be planted as trusted memory; beliefs go through `believe`.

**Untrusted-content fence.** Third-party text is wrapped in a nonce-suffixed `<untrusted-content>` tag (`system/lib/discretion/wrap-untrusted.ts`) with a note that it is data, never instructions. A literal close tag inside the text can't end the fence early, because the real close tag carries a per-call nonce. Look-alike tags inside the text are defanged, and the note says a block ends only at the nonce-suffixed close. The fence applies to every robin-extension integration result and error by default (only market quotes and Discord send receipts are exempt), to rows returned by `recall` and `list type=events` other than curated memory (integration records, research briefs, behavioral signals, and `remember` notes, which any session's model can write, are fenced; beliefs, knowledge docs, captured sessions and corrections are not — and those kinds are reserved on the write tools, from one shared registry), to integration evidence in the recommendation judge, and to scout digests. Discord posts set `allowed_mentions` so a quoted email subject can't ping `@everyone` or a role.

**Publish discretion gate.** `system/lib/publish/discretion.ts` runs before anything is uploaded and again on the final rendered page. It refuses credential shapes anywhere in the page (including inline JavaScript), PII shapes in the visible text, and booking references in the text or page JavaScript (a confirmation code or record locator, which with with a surname, enough to change a booking). `--allow-sensitive` overrides it for a verified false positive. Slugs matching the daily brief are always refused. Published pages sit at an unguessable HMAC-hashed URL and are served `noindex`, but they are **not access-controlled**: anyone with the URL can read the page.

**Agent sandbox.** Agentic `query()` runs only through `runAgent` (`system/agent/run-agent.ts`), which checks a per-surface daily USD cap against the usage ledger before each run, applies per-run turn, time, and budget caps and a tool allowlist, and writes a JSONL transcript. Write handlers run in a throwaway git worktree (`system/agent/worktree.ts`, under `.worktrees/`) on a fresh `agent/<ts>` branch, inside the SDK's OS-level sandbox (seatbelt on macOS, bubblewrap on Linux). The sandbox confines every write to the worktree and is fail-closed: if the host can't sandbox, the run errors instead of running unconfined. It grants no `.git` access, so a handler cannot commit. A `canUseTool` deny callback sits behind it as a second check. Knowledge-curation handlers are confined the same way to the knowledge directory.

**Loopback binding and the local-browser gate.** The daemon's HTTP surface (`system/surfaces/http/server.ts`) and the remote MCP server bind to `127.0.0.1`; public reach requires a tunnel you set up deliberately. Loopback doesn't stop the browser on the same machine, so the daemon also refuses (403) any request whose `Host` isn't `127.0.0.1`, `localhost`, or `[::1]` on its port (DNS rebinding), and any request carrying an `Origin` header or a `Sec-Fetch-Site` other than `none` (a web page). The hooks (`curl`) and the CLI send none of these. The SessionEnd hook reads a transcript only from inside `~/.claude/projects/` (symlinks resolved) and under the 10 MB cap.

**Remote MCP auth.** `robin mcp remote` (`system/surfaces/mcp/remote/`) is its own OAuth 2.1 authorization server: protected-resource and authorization-server metadata, dynamic client registration, mandatory S256 PKCE, 1-hour access tokens, and refresh tokens that rotate on use. The consent screen is gated by an access key (`ROBIN_MCP_REMOTE_TOKEN`, at least 32 characters, compared in constant time); it is entered in the browser and never sent to the client. Codes and tokens are stored only as SHA-256 hashes. Tokens carry one of two scopes, chosen on the consent screen: `robin:read` reaches the read-only tool list, `robin:write` adds a short list of memory-ledger writes. Tools not on those lists, and the write branches of mixed tools, are unreachable remotely. Dynamic client registration accepts only `https` redirect URIs on `claude.ai`/`claude.com` (plus loopback for testing, and any hosts in `ROBIN_MCP_REDIRECT_HOSTS`), and `/authorize` re-checks them, so a registered attacker callback can't receive a code.

**Personal details stay in user-data.** The operator's name, prompt context, aliases, home location and weather stations live in `user-data/config/operator.yaml` (`system/lib/operator-profile.ts`), not in code. Without it, prompts say "the user" and location-based integrations skip rather than guess. `system/scripts/private-scan.mjs` refuses personal data — operator.yaml terms, the people, medications and accounts in Robin's memory, deployment hostnames from the secrets file (hosts only, never values), and phone/mailbox/last-4 shapes — at three points: the `pre-commit` hook (staged content and the commit identity), the `pre-push` hook (every pushed commit's content, message and author, failing closed), and a guard test over all tracked files. Added lines are also compared against the operator's personal notes, corrections and beliefs (6-word runs), so a copied fact is caught even when it names no one.

**Telemetry.** Telemetry events written through `writeTelemetry()` are validated against a registered zod schema per kind; an invalid payload throws instead of being written.
