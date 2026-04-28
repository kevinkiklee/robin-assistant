# Changelog

## [3.1.0] - 2026-04-28

### Breaking changes
- `memory/index/` (sidecar `.idx.md` tree) removed. Replaced by a single generated `memory/INDEX.md` driven by per-file `description:` frontmatter.
- `user-data/trips/` consolidated into `user-data/memory/events/`.
- Inline `<!-- id:... -->` pointer comments removed from `knowledge.md` and `profile.md` (kept in `inbox.md`).
- `indexing.status` config field removed (no longer used).

### Memory restructure (two phases)

The new architecture organizes memory into topic folders (`profile/`, `knowledge/`, `events/`) with a generated `INDEX.md`. Because the existing `knowledge.md` and `profile.md` use level-2 headings for both top-level domains AND sub-sections, mechanical splitting would mis-place content. The migration is therefore split into two phases:

**Phase 1 (automatic, runs at session startup via `0003-flatten-memory`):**
- Drops the sidecar index tree.
- Relocates `user-data/trips/` to `user-data/memory/events/`.
- Adds `description:` frontmatter to flat files and to `knowledge.md` / `profile.md` (which are preserved as monoliths).
- Generates `memory/INDEX.md`.

**Phase 2 (interactive, run when you're ready):**
- Run `npm run split-monoliths` from a terminal to split `knowledge.md` and `profile.md` into topic folders.
- For each `## ` heading, the splitter prompts whether it's a domain root (becomes its own file) or a child (kept as a `## ` subsection inside the preceding root's file).
- Smart defaults: first heading defaults to root; small sections default to child.
- After confirmation, topic files are written, cross-references are repaired, and INDEX.md is regenerated.

### New
- `memory/INDEX.md` — generated directory of every memory file.
- Threshold-based topic splitting in Dream. When a topic file crosses `memory.split_threshold_lines` (default 200), Dream splits it at `## ` boundaries. Applies to topic files only — exempts `knowledge.md`, `profile.md`, `decisions.md`, `journal.md`.
- New scripts: `system/scripts/regenerate-memory-index.js` (with `--check`), `system/scripts/split-monoliths.js`, `system/scripts/lib/memory-index.js`.
- New npm scripts: `regenerate-memory-index`, `split-monoliths`.
- `memory.split_threshold_lines` config option.

### Behavior
- Dream consults `INDEX.md` to route inbox entries into topic files. New topic files for inbox-routed content are Dream-only (avoids stale-INDEX windows). User-authored documents (events, derived analyses) can still be created mid-session with frontmatter.
- Startup loads `memory/INDEX.md` plus `profile/identity.md` and `profile/personality.md`. If those topic files don't exist yet (Phase 2 not run), startup falls back to loading `profile.md` directly.

## [3.0.0] - 2026-04-27

### Breaking changes
- Distribution model changed from npm package (`npx robin-assistant init`) to git-clone. The repo IS the workspace. See README for new onboarding.
- Layout: system files now under `system/`; personal data under `user-data/` (gitignored).
- Protocols renamed to operations: `system/protocols/` → `system/operations/`.
- `AGENTS.md` moved to repo root (per the AGENTS.md community spec).
- `robin` CLI binary retired. Functionality exposed as `npm run <command>`: `backup`, `restore`, `reset`, `install-hooks`, `migrate`, `migrate-v3`.
- `export` renamed to `backup`; `rollback` renamed to `restore` (now restores user-data from a backup tar.gz, not system files from an update backup).
- `init` removed — `git clone` replaces it.
- `update` removed — `git pull` is the update verb.
- `Rule: Remote Exposure Guard` removed (remotes are now expected); replaced by gitignore + Node-based pre-commit hook.
- `commander` runtime dependency dropped — repo has zero runtime deps.

### New
- Migration framework at `system/migrations/`. Drop a versioned migration file; it auto-applies on session start with a pre-migration backup.
- Customization extension points: `user-data/custom-rules.md`, `user-data/operations/` (overlays `system/operations/`).
- `artifacts/` directory: `artifacts/input/` for user-supplied files (not auto-read), `artifacts/output/` for AI-generated artifacts.
- Auto-applied additive config schema migrations on session start (`lib/config-migrate.js`).
- Generated root pointer files (`CLAUDE.md`, `.cursorrules`, `GEMINI.md`, `.windsurfrules`) from `system/scripts/lib/platforms.js`.
- Auto-generated `system/operations/INDEX.md` from per-operation YAML frontmatter.
- CHANGELOG-aware session-start notification (`lib/changelog-notify.js`).
- Native Antigravity support (reads root `AGENTS.md`).

### Migration from v2
Run `npm run migrate-v3 -- --from <path-to-v2-workspace>` from a fresh v3 clone. Source workspace is left untouched. See `docs/superpowers/specs/2026-04-27-distribution-redesign-design.md` for full migration semantics.

---

## 2.1.0 — Memory Indexing & Metadata Layer

### Added
- Per-file sidecar indexes at `index/*.idx.md` with entry-level metadata (domains, tags, relationships, summaries)
- Root manifest at `manifest.md` providing file-level memory overview
- Timestamp-based entry IDs embedded in source files (`YYYYMMDD-HHMM-<session><seq>`)
- `robin migrate-index` command for upgrading v2.0.0 workspaces (Phase A: structural)
- Phase B semantic enrichment runs in background on first post-migration session
- Dream Phase 0 (index integrity) and Phase 4 (index maintenance)
- Index write step in capture rules — entries are indexed at capture time
- Controlled domain vocabulary: work, personal, finance, health, learning, home, shopping, travel
- Tag normalization rules (lowercase, hyphen-separated)
- Cross-reference syntax for linking entries across files
- Validation checks for index integrity on v2.1.0 workspaces

### Changed
- Config version bumped to 2.1.0 with `indexing` status field
- Startup sequence includes Phase B check and manifest reading
- Dream protocol expanded with Phase 0, Phase 4, and entry movement indexing
- Capture rules include index write step and trip indexing

## 1.0.0 (Unreleased)

Initial release.

- CLI with 9 commands: init, configure, update, check-update, rollback, validate, version, export, reset
- Core operational files: 12 protocols, coordination scripts, self-improvement framework, privacy scan
- Dream protocol for automatic memory consolidation
- Passive knowledge capture system
- Override system for user customizations
- Multi-session coordination with atomic locks
- Auto-update check with user approval
- Pre-push git hook for privacy protection
- `trips/` directory scaffolded on init with `_template.md` showing per-trip structure (was referenced in `AGENTS.md` but not created)
