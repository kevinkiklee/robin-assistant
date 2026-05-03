---
name: deep-ripple
dispatch: inline
model: opus
triggers: ["deep ripple", "find missing links", "expand the wiki graph"]
description: Agent-driven semantic pass that proposes links the mechanical linker missed (paraphrases, role references, indirect mentions).
runtime: "agent"
enabled: false
timeout_minutes: 20
---
# Protocol: Deep Ripple

A semantic pass over the wiki that proposes cross-references the mechanical linker can't catch — paraphrases like "my therapist", role references, indirect mentions.

## Trigger

User-initiated only. Trigger phrases: "deep ripple", "find missing links", "expand the wiki graph".

## Scope

Optional: `deep ripple medical`, `deep ripple all` (default).

## Workflow

1. Build the entity registry: read frontmatter from in-scope entity pages (`knowledge/**`, `profile/**`), produce list of `{ canonical, aliases, path }`.
2. For each in-scope file (respecting `EXCLUDED_PATHS`), read alongside the registry list and `INDEX.md`.
3. Propose additional `[text](path.md)` links the mechanical linker missed:
   - paraphrases ("my therapist" → therapist-iacoviello.md)
   - role references ("the recruiter" → person page)
   - indirect mentions ("the rooftop" → home/outdoor-space.md)
4. Output a structured suggestion list grouped by file:

```
## Suggested Links (N)
### profile/identity.md
- line 12: "the rooftop garden" → home/outdoor-space.md
### knowledge/medical/health-snapshot.md
- line 7: "my therapist" → medical/therapist-iacoviello.md
```

5. **Do not write.** User reviews suggestions and replies "apply these" with selection. Agent then applies via Edit tool, file by file.

## Boundary rule

Deep ripple reads any file under `user-data/memory/`. Writes only after explicit user approval. Never writes to `EXCLUDED_PATHS`.
