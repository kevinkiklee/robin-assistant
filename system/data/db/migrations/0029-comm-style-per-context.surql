-- 0029-comm-style-per-context.surql
--
-- Adds comm_style_contexts to persona for per-context comm-style synthesis
-- (cognition-e1 spec §4d).
--
-- comm_style_contexts holds per-platform synthesized comm-style records for
-- discord / terminal / web contexts. Each context record is FLEXIBLE (same
-- approach as comm_style). Under-evidenced contexts stay null; inject reads
-- fall back to comm_style (the default flat shape, unchanged).
--
-- No changes to existing comm_style field — backward-compatible.

DEFINE FIELD comm_style_contexts ON persona TYPE option<object> FLEXIBLE;
