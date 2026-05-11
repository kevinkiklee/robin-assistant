-- 0013-comm-style.surql — extend profile with inferred communication style.
DEFINE FIELD comm_style ON profile TYPE option<object> FLEXIBLE;
UPSERT profile:singleton CONTENT { meta: {} } RETURN NONE;
