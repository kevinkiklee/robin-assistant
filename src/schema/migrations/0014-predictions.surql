-- 0014-predictions.surql — predictions tracking + calibration
DEFINE TABLE predictions SCHEMAFULL;
DEFINE FIELD statement              ON predictions TYPE string;
DEFINE FIELD kind                   ON predictions TYPE string;
DEFINE FIELD confidence             ON predictions TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD predicted_at           ON predictions TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD expected_resolution_at ON predictions TYPE option<datetime>;
DEFINE FIELD resolved_at            ON predictions TYPE option<datetime>;
DEFINE FIELD correct                ON predictions TYPE option<bool>;
DEFINE FIELD actual_outcome         ON predictions TYPE option<string>;
DEFINE FIELD meta                   ON predictions TYPE option<object> FLEXIBLE;
DEFINE INDEX predictions_kind ON predictions FIELDS kind;
DEFINE FIELD calibration ON profile TYPE option<object> FLEXIBLE;
