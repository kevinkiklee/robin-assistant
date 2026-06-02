import type { Migration } from './types.ts';

export const migration020: Migration = {
  version: 20,
  name: 'candidate-dedup-recall-outcome',
  up: (db) => {
    // ── Semantic dedup of belief candidates ──────────────────────────────────
    // The biographer re-extracts the same durable life-fact every run as a fresh
    // paraphrase under a fresh topic slug; exact (topic, claim) dedup misses them,
    // so paraphrases pile up in the pending queue (measured: one NAS fact as 20
    // pending rows / 6 slugs). `embedding` stores the claim's vector so a new draft
    // can be compared (cosine) against existing pending candidates without
    // re-embedding the whole queue; `corroboration_count` records how many times the
    // same fact was independently extracted (the canonical row's confidence signal).
    db.exec(`ALTER TABLE belief_candidates ADD COLUMN embedding BLOB;`);
    db.exec(
      `ALTER TABLE belief_candidates ADD COLUMN corroboration_count INTEGER NOT NULL DEFAULT 1;`,
    );
    // Why a candidate was resolved (e.g. 'paraphrase-dup' from the dedup sweep,
    // 'external-not-durable' / 'below-threshold-for-class' from the promotion gate).
    // Makes rejections auditable and reversible — you can tell a dedup collapse apart
    // from a staleness expiry or a gate block.
    db.exec(`ALTER TABLE belief_candidates ADD COLUMN resolved_reason TEXT;`);

    // ── Recall-outcome loop ──────────────────────────────────────────────────
    // recall_log rows were all stuck at outcome='pending' (the deferred dream
    // scoring never shipped) and stored only query_hash/result_count/source — no
    // way to judge recall quality. These columns let outcome be set deterministically
    // at log time (miss/answered) and begin accumulating the linkage (top score,
    // session, which content was surfaced) a richer scorer would need later.
    db.exec(`ALTER TABLE recall_log ADD COLUMN top_score REAL;`);
    db.exec(`ALTER TABLE recall_log ADD COLUMN session_id TEXT;`);
    db.exec(`ALTER TABLE recall_log ADD COLUMN injected_content_ids TEXT;`);
  },
};
