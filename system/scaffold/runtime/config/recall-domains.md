---
description: Domain-trigger recall map. Matches user message against keywords; injects mapped memory files at session prompt time. User-editable.
type: reference
---

# Recall domains

Format: each section is a domain. Keywords are matched case-insensitive with
word boundaries. Files are injected as `<!-- relevant memory -->` blocks by
the `onUserPromptSubmit` hook (`system/scripts/hooks/lib/domain-recall.js`).

This is a parallel pass to entity-alias recall. Use it for activity / topic
keywords that don't match an entity name (e.g. "fertilizer" doesn't name an
entity but should still surface the rooftop garden file).

The defaults below are deliberately narrow — over-matching wastes context
budget and slows the hook. Add domains as needed; remove or narrow keywords
that fire frequently with no value (Dream Phase 11.5 surfaces dead keywords).

## gardening
keywords: garden, gardening, plant, plants, fertilizer, soil, mulch
files:
  - user-data/memory/knowledge/home/outdoor-space.md

## finance
keywords: investment, IRA, 401k, Roth, brokerage, retirement, taxes
files:
  - user-data/memory/knowledge/finance/financial-snapshot.md

## health
keywords: whoop, recovery, HRV, sleep score, strain
files:
  - user-data/memory/knowledge/health/whoop.md

## briefing freshness
keywords: today's, this morning, latest
files:
  - user-data/runtime/jobs/daily-briefing.md
