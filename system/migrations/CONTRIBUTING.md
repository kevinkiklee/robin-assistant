# Migration Authoring Contract

Migrations apply destructive changes to user data. Get them wrong and Kevin's
journals, decisions, financial history go away. This contract is binding.

## Numbering

Strictly sequential. Pick the next available `<N>-<slug>.js`. **Never reorder
after merge** — applied numbers are stored in
`user-data/runtime/state/migrations-applied.json` and the runner relies on numerical order
for dependency resolution.

If a migration's purpose changes after merge, write a new migration that
amends it. Don't edit the original.

## Module shape

```js
import { ... } from 'node:fs';
import { join } from 'node:path';

export const id = '<NNNN>-<slug>';
export const description = 'One-line summary that surfaces in migrate logs.';

export async function up({ workspaceDir, helpers, opts }) {
  // mutate workspaceDir; idempotent
}
```

## Mandatory properties

### 1. Idempotent

Re-running must be a no-op. Pattern:

```js
if (existsSync(target)) {
  console.log('[NNNN] target exists — no-op');
  return;
}
```

CI tests applying a migration twice in a row. The second run must produce no
side effects.

### 2. Pre-migration backup

The runner (`migrate/apply.js`) handles this automatically — `user-data/` is
tarballed to `user-data/backup/pre-migration-<ts>.tar.gz` before any migration runs.
**Don't disable.** If a migration writes to a non-`user-data/` path, it
must take its own backup.

### 3. Reversible (or document why not)

Default: design the migration so a user can run a small reverse script.
Examples:
- File splits → "concat the split files back" (test in unit tests).
- Field renames → "rename back via helpers.renameConfigField".
- File creations → "delete the file".

Pure deletions don't need a reverse — the backup is the reverse. Note this
in the migration's docstring.

### 4. Crash-safe

Each step is atomic *or* the migration tolerates partial completion. If you
write to `path` then rename `path.tmp → path`, that's atomic. If you write
to multiple files, idempotency must handle the case where some succeeded
and some didn't. **A retry of a partially-applied migration must converge.**

### 5. Tests

Add `system/tests/migrate/migration-<slug>.test.js` covering:

- Happy path on a fresh fixture.
- Re-run on already-migrated state (idempotent → no-op).
- Corrupt-state input (parse failure) — quarantine, don't crash.
- Partial-state input — converge on second run.

## Available helpers

`createHelpers(workspaceDir)` provides:

- `renameFile(old, new)` — idempotent rename inside `user-data/`.
- `removeFile(name)` — idempotent delete.
- `addFileFromScaffold(name)` — copy from `system/scaffold/` if missing.
- `addConfigField(jsonPath, defaultValue)` — set `robin.config.json` field if absent.
- `renameConfigField(oldPath, newPath)` — rename without losing value.
- `transformFileContent(name, fn)` — read, transform, write a file.

## Logging

Use `console.log('[NNNN] message')`. Surface what changed and why. Logs
appear in the user's terminal during `npm install` and at session start.

## What NOT to do

- **No interactive prompts** unless `opts.interactive === true`. CI runs
  with `interactive: false`.
- **No network calls.** Migrations run offline.
- **No async ops without await.** Migrations are awaited; an unawaited
  promise can leave state in flight when the next migration runs.
- **No reading the user's secrets** (`user-data/runtime/secrets/`). If a migration
  needs to know an API key, it's not a migration — it's a configuration step
  that belongs in `robin configure`.

## Conventions

- File naming: `<NNNN>-<kebab-slug>.js`. Example: `0008-split-self-improvement.js`.
- Slugs are short and descriptive. The number is your timestamp; slug is
  the elevator pitch.
- One migration = one logical change. Don't bundle.
- Quarantine corrupt input rather than failing forever. Pattern:
  `renameSync(corrupt, corrupt + '.corrupt-<ts>')`.

## Review checklist

Before merging a migration:

- [ ] Has a clear `description`.
- [ ] Idempotency is explicit (early-return when target state present).
- [ ] No interactive prompts in non-interactive mode.
- [ ] Tests cover happy / re-run / corrupt / partial.
- [ ] Logging is informative.
- [ ] Reversibility documented (or pure-delete justification given).
- [ ] No network / secrets access.
