# Contributing to Robin

Thanks for thinking about contributing. Robin is a personal AI assistant — the bar is "does this make my (or another user's) Robin experience meaningfully better without compromising the architectural invariants the project holds."

## Before you start

Read these in order:
1. `docs/specs/2026-05-18-robin-v3-design.md` — the architectural baseline (what's locked, why)
2. `docs/STATUS.md` — current implementation snapshot
3. `docs/BACKLOG.md` — deferred work organized by priority; pick from here if you don't have your own idea

## Architectural invariants (enforced by CI)

These are tests that fail if the locked decisions are silently violated. Don't work around them — work with them:

- **No config files under `system/`** (`tests/architecture/boundary.test.ts`). All YAML/JSON/.env runtime config lives in `user-data/config/`.
- **Migration versions are monotonic and kebab-case** (`tests/architecture/migrations-monotonic.test.ts`).
- **Every telemetry kind has a registered zod schema** (`tests/architecture/telemetry-kinds.test.ts`).

## Development setup

```bash
git clone <your fork>
cd robin-assistant-v3
nvm use            # picks Node 24 via .nvmrc
pnpm install
pnpm test          # 170+ tests, ~5s
pnpm typecheck
pnpm lint
```

If `better-sqlite3` errors with `NODE_MODULE_VERSION` mismatch, you're on the wrong Node version — switch to Node 24 (`nvm use 24`) and re-run.

## Code style

- TypeScript strict mode, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`
- Biome v2 for formatting and linting (`pnpm lint:fix`, `pnpm format`)
- Single quotes, semicolons, 100-character line width
- No `any` unless interfacing with an untyped boundary (and even then, narrow at the boundary)
- Files focused; if a file gets large, propose a split

## Test discipline

- Unit tests use `node --test` with `--import tsx`
- Mock at the boundary — never hit live APIs in CI
- Real-API tests go in `tests/integration/` and run locally, never in GitHub Actions (privacy: never put real personal account secrets in CI)
- Each PR keeps `pnpm test` green; broken tests block merge

## Adding an integration

1. Copy `system/integrations/builtin/weather/` as a template
2. Fill in `integration.yaml` with manifest, permissions, schedule, mcp.actions
3. Implement `index.ts` with `tick()`, `health()`, and exported `actions` map
4. Write `index.test.ts` with mocked `fetch`
5. If shared OAuth or auth flow needed, drop the helper under `system/integrations/_auth/`
6. Add the integration's action-dispatch tool to `system/surfaces/mcp/extension/server.ts`

## Pull request checklist

- [ ] Description explains *why*, not just *what*
- [ ] Tests added or updated
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green locally
- [ ] No new config files under `system/`
- [ ] No secrets in code, commits, or tests
- [ ] Updated `docs/STATUS.md` if user-visible behavior shipped
- [ ] Updated `docs/BACKLOG.md` if you closed an item

## Security

See `SECURITY.md`. Don't open public issues for security problems.

## License

By contributing, you agree your contributions are licensed under MIT.
