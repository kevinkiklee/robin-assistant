# Contributing to Robin

Thanks for thinking about contributing. Robin is a personal AI assistant — the bar is "does this make my (or another user's) Robin experience meaningfully better without compromising the architectural invariants the project holds."

## Before you start

Read these in order:
1. `CLAUDE.md` — architecture, commands, and conventions as they are today
2. `docs/ARCHITECTURE.md` — how the layers fit together
3. `docs/STATUS.md` — current implementation snapshot
4. `docs/BACKLOG.md` — open work, each item with evidence; pick from here if you don't have your own idea

## Architectural invariants (enforced by tests)

CI (`.github/workflows/tests.yml`) runs `pnpm typecheck`, `pnpm lint`, and `pnpm test` on every push to `main` and every PR against it. `main` has no branch protection, so a red run doesn't block a merge by itself — keep it green. These guard tests fail when a locked decision is silently violated. Don't work around them — work with them:

- **No config files under `system/`** (`system/tests/architecture/boundary.test.ts`). Files with a config extension (`.yaml`, `.yml`, `.json`, `.env`, `.toml`, `.ini`) fail the test, except the framework manifests `integration.yaml` and `job.yaml`. Runtime config lives in `user-data/config/`.
- **Migration versions are sequential from 1, and names are kebab-case** (`system/tests/architecture/migrations-monotonic.test.ts`). Never edit an applied migration; add a new one.
- **Every telemetry kind has a zod schema and a dot-namespaced name** (`system/tests/architecture/telemetry-kinds.test.ts`).
- **No raw `new Database(` outside a short allowlist** (`system/brain/memory/db-open.test.ts`). Open connections through `openDb()` so the registered guards and init hooks apply.
- **The lab's read/score paths never read the wall clock directly** (`system/lib/clock-lint.test.ts`). Those files take "now" from `system/lib/clock.ts`.
- **No personal data in tracked files** (`system/tests/architecture/no-personal-data.test.ts`, plus the git hooks below). The repo is public. It runs `system/scripts/private-scan.mjs` over every tracked file: the operator's name, aliases, home label and `private_terms` from `user-data/config/operator.yaml`, the people, medications and accounts in Robin's own memory, and personal shapes (US phone numbers, personal-mailbox addresses, account last-4s). It runs wherever a profile or memory exists (the maintainer's machine) and skips on CI.
- **Lab code stays isolated** (`lab/lint.test.ts`): no imports of the MCP/HTTP surfaces, the scheduler, or the paid agent provider, and no `loadEnvFile`. `lab/privacy/privacy.test.ts` checks that sim prompts and rendered fixtures carry no forbidden strings.

CI also runs a smoke step (`robin init --yes`, then `robin doctor --json` against a throwaway user-data dir; any critical failure fails the build), and `.github/workflows/gitleaks.yml` scans for secrets.

Conventions that are **not** enforced by a test, so review has to catch them: agentic `query()` goes only through `system/agent/run-agent.ts` (`runAgent`), and non-agentic LLM work goes through the dispatcher (`llm.invoke(role, …)`).

## Development setup

```bash
git clone <your fork>
cd robin-assistant
nvm use            # picks Node 24 via .nvmrc
pnpm install       # also points core.hooksPath at githooks/ (the `prepare` script)
pnpm typecheck
pnpm lint
pnpm test
```

Other scripts in `package.json`:

```bash
pnpm robin <cmd>   # run the CLI from source against ./user-data
pnpm dev           # run the daemon in the foreground from source (dev:watch reloads)
pnpm lab <cmd>     # the test lab — see lab/README.md
pnpm build         # tsc + compile user-data extensions in place → dist/
pnpm exec tsx --test <file>   # run a single test file
```

If `better-sqlite3` errors with `NODE_MODULE_VERSION` mismatch, you're on the wrong Node version — switch to Node 24 (`nvm use 24`) and re-run `pnpm install`.

## Personal data

**Git hooks enforce this.** `githooks/pre-commit` refuses a commit whose staged content matches the scanner, or whose author/committer identity is personal (even when passed with `-c`), and `githooks/pre-push` scans every commit being pushed (content, message, author and committer), so a `--no-verify` commit is still caught. Besides terms, memory names, deployment hostnames taken from the secrets file (hosts only) and personal shapes, added lines are compared against the operator's own notes, corrections and beliefs: a line sharing a 6-word run with them is refused, because a fact can leak with no name in it. The personal sources beyond the profile are listed in `operator.yaml` under `private_sources`. Run `node system/scripts/private-scan.mjs --tracked --deep` to audit the whole tree. Pre-push fails closed. `pnpm install` points `core.hooksPath` at `githooks/`. A line that must contain a matching shape on purpose (the scanner's own fixtures) can end with `privacy-scan:allow`.

The repository is public and must not identify its operator. Read personal values at runtime from `system/lib/operator-profile.ts` (`operatorName()`, `operatorProfile()`), which loads the gitignored `user-data/config/operator.yaml`, and degrade gracefully when they're absent (generic prompts, skipped location features). Never hardcode a name, place, account, handle or coordinate. Test fixtures use fictional data ("Sam Rivera", "Acme"). Operator-specific instructions for Claude go in the gitignored `CLAUDE.local.md`.

## Code style

- TypeScript `strict`, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch` (`tsconfig.json`)
- Biome v2 for formatting and linting (`biome.json`): 2-space indent, single quotes, semicolons, 100-character line width, recommended lint rules. `pnpm lint` runs `biome check .`; `pnpm lint:fix` and `pnpm format` write fixes.
- The committed `githooks/pre-commit` hook runs `biome format --write` on staged files and re-stages them. It never blocks a commit and never applies lint fixes, so still run `pnpm lint`, `pnpm typecheck`, and `pnpm test` yourself.
- No `any` unless interfacing with an untyped boundary (and even then, narrow at the boundary)
- Match the surrounding style. Keep files focused; if a file gets large, propose a split.

## Test discipline

- Tests use `node:test` + `node:assert`, run through `node --test --import tsx`
- Tests are collocated: `foo.ts` → `foo.test.ts`. `pnpm test` picks up `system/**`, `lab/**`, `user-data/extensions/**`, and `user-data/scripts/**`.
- Cross-cutting tests live in `system/tests/` (`architecture/` guards, `integration/` end-to-end runs against a temp user-data dir, `golden/`). They run in CI like everything else.
- Mock at the boundary (`fetch`, the LLM provider) — tests never hit live APIs or read real secrets
- Memory-pipeline tuning experiments belong in the test lab (`lab/`), which replays a synthetic life through a sandboxed copy of the pipeline — see `lab/README.md`
- Each PR keeps `pnpm test` green; broken tests block merge

## Adding an integration

Integrations live in one of two places:
- **Builtin** — `system/integrations/builtin/<name>/`, shipped with the repo
- **User extension** — `user-data/extensions/integrations/<name>/`, per-user and gitignored

Steps:
1. Copy `system/integrations/builtin/weather/` as a template
2. Fill in `integration.yaml`: `name`, `version`, `schedule` (cron or `manual`), optional `tz`, and `permissions` (`memory`, `network`, `secrets`). An `mcp:` block describing actions is optional documentation; the MCP tool is built from the exported `actions` map.
3. Implement `index.ts`: export `integration` (or a default export) with `tick()` and optional `init()`, `health()`, `cleanup()`; export an `actions` map for MCP actions. Ticks run inside a 120s timeout.
4. Write `index.test.ts` with a mocked `fetch`
5. If you need a shared OAuth or auth flow, put the helper under `system/integrations/_auth/`
6. Expose the actions over MCP. Builtin: import the `actions` map in `system/surfaces/mcp/extension/server.ts` and register it with `makeIntegrationTool`. User extensions are discovered automatically at MCP server start.
7. Any entry point that runs integrations must call `loadEnvFile(userData)` first, or the integration silently skips with "not set"

## Pull request checklist

- [ ] Description explains *why*, not just *what*
- [ ] Tests added or updated
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green locally
- [ ] No new config files under `system/`
- [ ] No secrets in code, commits, or tests
- [ ] Nothing staged from `user-data/`
- [ ] No personal data: personal values come from `operator-profile.ts` at runtime, and fixtures use fictional people, places and accounts
- [ ] Updated `docs/STATUS.md` if user-visible behavior shipped
- [ ] Updated `docs/BACKLOG.md` if you closed an item

## Security

See `SECURITY.md`. Don't open public issues for security problems.

## License

By contributing, you agree your contributions are licensed under MIT.
