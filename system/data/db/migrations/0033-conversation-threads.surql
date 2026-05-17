-- 0033-conversation-threads.surql
--
-- Cross-channel conversation continuity (M2). When the user pings via
-- iMessage at 9am then via terminal at 9:15am, the second turn should be
-- aware of the first within a rolling window.
--
-- Threads are keyed by (channel, peer_id, time-bucket). The same peer on the
-- same channel within the inactivity window resumes; outside the window, a
-- new thread starts. peer_id semantics:
--   imessage DM   → normalized handle
--   imessage group→ chat_guid
--   discord DM    → discord user id
--   terminal      → 'terminal'
--
-- `channel_history` is the rolling message buffer injected into the agent
-- system prompt. Capped client-side (default 15 msgs / 4K tokens). Older
-- turns drop via tail-pruning when limits exceeded.
--
-- Long-tail recall (week-old context) uses the existing semantic recall over
-- events — this table is short-term scratch only.

DEFINE TABLE conversation_threads SCHEMAFULL TYPE NORMAL;
DEFINE FIELD thread_id        ON conversation_threads TYPE string;
DEFINE FIELD channel          ON conversation_threads TYPE string;
DEFINE FIELD peer_id          ON conversation_threads TYPE string;
DEFINE FIELD first_msg_at     ON conversation_threads TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_msg_at      ON conversation_threads TYPE datetime DEFAULT time::now();
DEFINE FIELD channel_history    ON conversation_threads TYPE array DEFAULT [];
DEFINE FIELD channel_history[*] ON conversation_threads TYPE object FLEXIBLE;
DEFINE FIELD token_count      ON conversation_threads TYPE int DEFAULT 0;
DEFINE INDEX ct_thread_id     ON conversation_threads FIELDS thread_id UNIQUE;
DEFINE INDEX ct_last_msg      ON conversation_threads FIELDS last_msg_at;
DEFINE INDEX ct_channel_peer  ON conversation_threads FIELDS channel, peer_id;
