# Data Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Robin's captured data maximally useful by adding capture-time metadata, biographer session finalization (intent/outcome/topics/decisions), cross-session linking, and integration body enrichment.

**Architecture:** Three layers — cheap inline metadata at capture time (no LLM), expanded biographer with a session finalization LLM call after chunk extraction, and deterministic cross-session topic threading. Integration events (Whoop, finance, calendar) gain human-readable bodies with deltas.

**Tech Stack:** TypeScript, better-sqlite3, Zod schemas, cloud LLM via dispatcher, node:test

---

### Task 1: Capture-time metadata

**Files:**
- Modify: `system/brain/cognition/capture.ts` (lines 116-178)
- Modify: `system/brain/cognition/capture.test.ts`

**Changes:** Add `userTurnCount`, `assistantTurnCount`, `bodyChars`, `hasCodeBlocks`, `hasToolUse`, `topicHints` to the session payload in `captureSession()`.

### Task 2: Session finalization schema + functions

**Files:**
- Modify: `system/brain/cognition/biographer.ts`

**Changes:** Add `sessionSummarySchema`, `finalizeSession()`, `updateSessionPayload()` functions. The finalization prompt, timeout handling, and single/multi-chunk input assembly.

### Task 3: Wire finalization into biographer

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (runBiographer, before writeExtractedMarker)

**Changes:** Add the finalization call + cross-session linking after entity/relation upsert, before writeExtractedMarker.

### Task 4: Biographer finalization tests

**Files:**
- Modify: `system/brain/cognition/biographer.test.ts`

**Changes:** Tests for session finalization (summary written to payload), cross-session threading, and failure tolerance (finalization failure doesn't block extraction).

### Task 5: Whoop integration enrichment

**Files:**
- Modify: `user-data/extensions/integrations/whoop/index.ts`

**Changes:** Add delta computation (vs 7d avg) and streak detection. Enrich the content body with narrative including deltas.

### Task 6: Finance integration enrichment

**Files:**
- Modify: `system/integrations/builtin/finance_quote/index.ts`
- Modify: `system/integrations/builtin/finance_quote/index.test.ts`

**Changes:** Add 52-week high delta to payload. Enrich the content body with relative context.

### Task 7: Calendar integration enrichment

**Files:**
- Modify: `system/integrations/builtin/google_calendar/index.ts`
- Modify: `system/integrations/builtin/google_calendar/index.test.ts`

**Changes:** Add dayContext (meeting index, total scheduled time) to payload. Enrich content body.
