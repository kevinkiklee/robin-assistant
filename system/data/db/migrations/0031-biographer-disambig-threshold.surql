-- 0031-biographer-disambig-threshold.surql
--
-- Raise the biographer's stage-2 LLM-escalation floor from 0.80 to 0.85.
--
-- Background: with the gemini-3072 embedder profile, unrelated entity pairs
-- routinely score 0.80-0.83 cosine similarity (e.g. "vim"↔"WordPress" at
-- 0.822, "bat"↔"magnet" at 0.804). The old 0.80 floor escalated all of these
-- to stage 3, which spawns a Haiku CLI call per mention. Each null-result
-- spawn was wasted CPU + tokens. Auto-resolve at 0.92 stays untouched.

UPDATE type::record('runtime', 'biographer')
  SET value.config.stage2_low_threshold = 0.85
  WHERE value.config.stage2_low_threshold = 0.8
     OR value.config.stage2_low_threshold IS NONE;
