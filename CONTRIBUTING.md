# Contributing

Robin is a git-clone-as-workspace tool. The repo *is* the workspace, so dev work happens in a clone separate from your real Robin instance.

## Setting up a dev clone

Don't develop in the same clone you use for your daily Robin instance — `npm install`'s postinstall populates `user-data/` from `system/skeleton/`, and you don't want to mix dev work with your real memory. Use a separate path:

```bash
git clone <repo> ~/code/robin-dev
cd ~/code/robin-dev
npm install
```

`npm install` runs `system/scripts/setup.js`. In a TTY, it prompts for config; in CI, it skips prompts and writes a placeholder `user-data/robin.config.json`. Either way, you'll get a populated `user-data/` (gitignored), an `artifacts/` directory, and `.git/hooks/pre-commit`.

## Running tests

```bash
npm test
```

Tests use `node --test` and create their own temp dirs in `os.tmpdir()`. They don't depend on the dev clone's `user-data/`. A fresh clone with no postinstall should also pass — although in practice postinstall always runs.

## Adding a migration

Drop a versioned file into `system/migrations/` named `<NNNN>-<short-description>.js`:

```javascript
// system/migrations/0007-rename-knowledge-to-reference.js
export const id = '0007-rename-knowledge-to-reference';
export const description = 'Rename user-data/memory/knowledge.md to user-data/reference.md';

export async function up({ workspaceDir, helpers }) {
  await helpers.renameFile('knowledge.md', 'reference.md');
  await helpers.renameConfigField('memory.knowledgeFile', 'memory.referenceFile');
}
```

`helpers` comes from `system/scripts/lib/migration-helpers.js` and exposes idempotent operations: `renameFile`, `removeFile`, `addFileFromSkeleton`, `addConfigField`, `renameConfigField`, `transformFileContent`. Add new helpers there if you need them (with tests in `tests/migration-helpers.test.js`).

The migration framework auto-applies pending migrations on the next session start, taking a `backup/pre-migration-<timestamp>.tar.gz` snapshot first. Users get a one-line notice; if anything fails, restore is one `npm run restore` away.

Add a CHANGELOG entry for any user-visible behavior change. The session-start CHANGELOG notification surfaces it on the user's next session after `git pull`.

## Adding a job

Jobs are markdown files with frontmatter under `system/jobs/` (ships with the package) or `user-data/jobs/` (workspace-specific). Each job has a `runtime` (`agent` for LLM protocols, `node` for scripts), an optional `schedule` (cron expression, OS-local timezone), optional `triggers` (phrases for in-session invocation), and an optional `active` window for season-bounded jobs.

**Trigger-only protocol** (no schedule):
```markdown
---
name: investment-review
triggers: ["investment review", "review my portfolio"]
description: Walk through portfolio holdings, recent moves, and rebalancing prompts.
runtime: agent
enabled: true
timeout_minutes: 15
---

# Investment Review

…protocol body — this is the prompt sent to the agent…
```

**Scheduled job** (cron):
```markdown
---
name: weekly-review
description: Sunday 10am — review the week, identify themes, plan next week.
runtime: agent
enabled: true
schedule: "0 10 * * 0"
catch_up: true
timeout_minutes: 30
---

…body…
```

**Node-runtime job** (deterministic script):
```markdown
---
name: backup
description: Daily snapshot of user-data/ to backup/.
runtime: node
enabled: true
schedule: "0 3 * * *"
command: node system/scripts/backup.js
timeout_minutes: 5
---

…description body — not used as a prompt for node runtime…
```

Validate before committing:
```bash
node bin/robin.js jobs validate <name>
git add system/jobs/<name>.md
git commit -m "feat(jobs): add <name>"
```

The reconciler picks up the new job within 6 hours (or run `robin jobs sync` for immediate effect). Users can override your system job by dropping a `user-data/jobs/<name>.md` — either a full replacement or a shallow override (`override: <name>` + only the fields they want to change). Don't break that contract.

For scheduled jobs, see also `docs/superpowers/specs/2026-04-29-job-system-design.md` for the full job-system design (runtime semantics, cross-platform install, telemetry, failure handling).

## Adding a new AI tool platform

Add an entry to `system/scripts/lib/platforms.js`:

```javascript
'newtool': {
  pointerFile: '.newtoolrules',  // or null if it reads AGENTS.md natively
  pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/memory/inbox.md with tags.\n',
  nativeIntegrations: {},
},
```

Then regenerate the pointer files:

```bash
npm run regenerate-pointers
git add system/scripts/lib/platforms.js .newtoolrules
git commit -m "feat(platforms): support newtool"
```

`tests/pointer-consistency.test.js` verifies committed root pointer files match `platforms.js`. CI catches drift.

## Commit conventions

Follow Conventional Commits with these scopes:

- `feat(component)` for new functionality
- `fix(component)` for bug fixes
- `refactor(component)` for non-behavioral changes
- `docs(component)` for documentation
- `test` for test-only changes
- `chore` for tooling and meta

Common components: `validate`, `backup`, `restore`, `reset`, `setup`, `hook`, `migrations`, `lib`, `operations`, `generate`, `AGENTS`, `startup`, `manifest`, `package`, `CHANGELOG`, `README`.

## Pull requests

Branch from `main`. Open the PR with a description that links the relevant CHANGELOG entry (or proposes one). All tests must pass. Don't commit anything under `user-data/`, `artifacts/`, `backup/`, or `docs/` — the pre-commit hook blocks it.

If you're sending changes that affect a user's existing data (e.g., file structure changes), include the migration in the same PR and the CHANGELOG entry should describe what users will see.
