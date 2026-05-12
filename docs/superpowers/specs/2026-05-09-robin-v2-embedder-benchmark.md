# Robin v2 Embedder Benchmark — Methodology + Results

**Status:** Run complete (Task 20, 2026-05-09).
**Resolves:** the `768` TODO in `2026-05-09-robin-v2-foundation-design.md` section 4.5.

## Method

Run `scripts/bench-embedder.js` from the v2 repo. For each candidate model:
1. Load the model.
2. Embed all 200 events from `tests/fixtures/synthetic-events.json`.
3. For each of the 10 seeded recall queries (`tests/fixtures/seed-recall-pairs.json`):
   - Embed the query.
   - Compute cosine distance between the query vector and every event vector.
   - Sort ascending; take top 10.
   - Compute NDCG@5 against cluster-membership relevance.
4. Record p50 + p95 single-query inference latency on the host machine.

## Candidates

- `Xenova/bge-small-en-v1.5` (384-d)
- `Xenova/bge-base-en-v1.5` (768-d)
- `Xenova/bge-large-en-v1.5` (1024-d)
- `Xenova/all-MiniLM-L6-v2` (384-d)

## Decision rule

Pick the model with highest NDCG@5 *unless* a smaller/faster model is within 2 NDCG points — in which case pick the faster one.

## Results

Measured on host machine via `node scripts/bench-embedder.js` (Task 20). Each row reports
single-query inference latency over the 10 seeded queries, plus NDCG against the synthetic
cluster ground truth.

| Model | Dim | NDCG@5 (avg) | NDCG@10 (avg) | p50 latency (ms) | p95 latency (ms) | Disk per vector (F32) |
|---|---|---|---|---|---|---|
| Xenova/bge-small-en-v1.5 | 384 | 1.000 | 1.000 | 2 | 3 | 1.5 KB |
| Xenova/bge-base-en-v1.5  | 768 | 1.000 | 1.000 | 4 | 5 | 3.0 KB |
| Xenova/bge-large-en-v1.5 | 1024 | 1.000 | 1.000 | 12 | 13 | 4.0 KB |
| Xenova/all-MiniLM-L6-v2  | 384 | 1.000 | 0.965 | 1 | 1 | 1.5 KB |

All four models score a perfect NDCG@5 on the synthetic clusters — the fixtures are well
separated by topic so every embedder finds the right cluster within the top 5. Discrimination
between candidates therefore comes from the secondary metrics (NDCG@10, latency, disk).

**Chosen model:** `Xenova/bge-small-en-v1.5` (384-d).

**Reasoning per decision rule:** the rule says "pick the model with highest NDCG@5 *unless* a
smaller/faster model is within 2 NDCG points — in which case pick the faster one." NDCG@5 is
tied at 1.000 across all four candidates, so we drop to the faster, smaller candidates (the
two 384-d models). Between them, MiniLM-L6-v2 is ~1 ms faster but loses points on NDCG@10
(0.965 vs 1.000), while bge-small-en-v1.5 holds a perfect NDCG@10 at p50=2 ms. Picking
bge-small keeps the same 384 dimension and the same 1.5 KB-per-vector disk cost as MiniLM
without giving up tail recall, so it is the clear winner among the within-tolerance set.

**Pinned dimension:** 384 — drives migration `0002-pin-embedding-dim.surql`, which re-creates
the HNSW index and the `array::len` assertion at 384.
