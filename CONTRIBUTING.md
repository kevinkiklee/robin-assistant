# Contributing

Robin is a git-clone-as-workspace tool. The repo *is* the workspace, so dev work happens in a clone separate from your real Robin instance.

## Setting up a dev clone

Don't develop in the same clone you use for your daily Robin instance — `npm install`'s postinstall populates `user-data/` from `core/skeleton/`, and you don't want to mix dev work with your real memory. Use a separate path:

```bash
git clone <repo> ~/code/robin-dev
cd ~/code/robin-dev
npm install
```

`npm install` runs `core/scripts/setup.js`. In a TTY, it prompts for config; in CI, it skips prompts and writes a placeholder `user-data/robin.config.json`. Either way, you'll get a populated `user-data/` (gitignored), an `artifacts/` directory, and `.git/hooks/pre-commit`.

## Running tests

```bash
npm test
```

Tests use `node --test` and create their own temp dirs in `os.tmpdir()`. They don't depend on the dev clone's `user-data/`. A fresh clone with no postinstall should also pass — although in practice postinstall always runs.

## Adding a migration

Drop a versioned file into `core/migrations/` named `<NNNN>-<short-description>.js`:

```javascript
// core/migrations/0007-rename-knowledge-to-reference.js
export const id = '0007-rename-knowledge-to-reference';
export const description = 'Rename user-data/knowledge.md to user-data/reference.md';

export async function up({ workspaceDir, helpers }) {
  await helpers.renameFile('knowledge.md', 'reference.md');
  await helpers.renameConfigField('memory.knowledgeFile', 'memory.referenceFile');
}
```

`helpers` comes from `core/scripts/lib/migration-helpers.js` and exposes idempotent operations: `renameFile`, `removeFile`, `addFileFromSkeleton`, `addConfigField`, `renameConfigField`, `transformFileContent`. Add new helpers there if you need them (with tests in `tests/migration-helpers.test.js`).

The migration framework auto-applies pending migrations on the next session start, taking a `backup/pre-migration-<timestamp>.tar.gz` snapshot first. Users get a one-line notice; if anything fails, restore is one `npm run restore` away.

Add a CHANGELOG entry for any user-visible behavior change. The session-start CHANGELOG notification surfaces it on the user's next session after `git pull`.

## Adding an operation

Drop `<name>.md` into `core/operations/` with YAML frontmatter:

```markdown
---
name: investment-review
triggers: ["investment review", "review my portfolio"]
description: Walk through portfolio holdings, recent moves, and rebalancing prompts.
---

# Investment Review

…body…
```

Then regenerate the index and commit both:

```bash
npm run regenerate-operations-index
git add core/operations/
git commit -m "feat(operations): add investment-review"
```

The `tests/operations-index-consistency.test.js` test verifies the committed INDEX matches what would be regenerated. CI catches drift.

Users can override your operation by dropping a same-named file in their own `user-data/operations/`. Don't break that contract — your operation is replaceable.

## Adding a new AI tool platform

Add an entry to `core/scripts/lib/platforms.js`:

```javascript
'newtool': {
  pointerFile: '.newtoolrules',  // or null if it reads AGENTS.md natively
  pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/inbox.md with tags.\n',
  nativeIntegrations: {},
},
```

Then regenerate the pointer files:

```bash
npm run regenerate-pointers
git add core/scripts/lib/platforms.js .newtoolrules
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
