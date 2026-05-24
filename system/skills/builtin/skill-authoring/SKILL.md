---
name: skill-authoring
description: How to create or edit a Robin skill — directory layout, SKILL.md frontmatter, system vs user skills, bundling scripts. Use when adding, fixing, or reviewing a skill.
metadata:
  version: "1.0"
---

# Authoring a Robin skill

A **skill** is a reusable, named methodology Robin loads on demand to do a specialized task. It is plain markdown (optionally bundling files). Robin never executes a skill — it serves the text and file paths; you (the agent) read and run anything yourself.

## Layout

A skill is a **directory**. The **directory name is the skill's identity** — it's what appears in the catalog and what you pass to `skill({ name })`. It must be kebab-case (`[a-z0-9][a-z0-9-]*`); other names are skipped.

```
<skill-name>/
  SKILL.md            # required
  reference/*.md      # optional supporting docs
  scripts/*           # optional scripts (run by the agent, never by Robin)
  templates/, assets/ # optional
```

Two locations:

- **System skill** — `system/skills/builtin/<name>/`. Ships in the `robin-assistant` package. **Must be generic** (no personal/user-specific content).
- **User skill** — `user-data/extensions/skills/<name>/`. Personal, gitignored. This is where your own skills go.

A user skill with the same name as a system skill **shadows** it (user wins), so you can override a shipped skill by copying its name into `user-data`.

## SKILL.md

```markdown
---
name: <should match the directory name; mismatch is ignored with a warning>
description: <one line — WHAT it does AND WHEN to use it>
metadata: { version: "1.0" }   # optional, free-form
---

<the methodology / instructions — loaded only when the skill is opened>
```

- `name` and `description` are **required**. A skill missing `description` is surfaced in the catalog as **invalid** (so you notice) but can't be loaded.
- The **`description` is the only thing visible in the catalog**, so it must carry its own weight: state the capability *and* the trigger ("Use when…"). Keep it to one or two lines — every skill's description costs context.
- The **body** can be as long as needed; it's only pulled when the skill is loaded.

## When to bundle files vs. inline

- Keep it to a single `SKILL.md` unless you genuinely need supporting material.
- Bundle `reference/*.md` for long lookup tables or details that would bloat the main flow.
- Bundle `scripts/*` only when a deterministic step is better as code. Document in the body exactly how to run them and what they need (args, env). The agent runs them under its own permissions — never assume Robin runs anything.

## How a skill is surfaced

The robin-core MCP server exposes a `skill` tool. Valid skills' names + descriptions are embedded in that tool's description (always visible), so a skill is discoverable as soon as it exists. Loading is on demand:

- `skill({ name: "<name>" })` → the full body, the skill's directory path, and a list of bundled files.
- `skill({ action: "list" })` → the whole catalog as data, including invalid skills and the reason they're invalid (use this to debug a skill that isn't showing up).

The catalog is read fresh from disk, but the always-visible description list is fixed when the MCP server starts — a newly added skill shows up in the next Claude Code session.

## Checklist for a good skill

- [ ] Directory name is kebab-case and matches `name`.
- [ ] `description` states capability **and** trigger, in ≤ 2 lines.
- [ ] Body is actionable methodology, not background prose.
- [ ] System skills are generic; anything personal lives in a user skill.
- [ ] If it bundles scripts, the body says exactly how to run them.
