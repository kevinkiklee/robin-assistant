# Calibration (P0)

Aggregate-only: every query returns counts, rates, month keys or bucket labels —
no topics, claims, names or content. The lab never opens the live DB; you run
this yourself, read-only:

    sqlite3 -readonly -json <path-to-live>/state/db/robin.sqlite < lab/calibrate/rates.sql

Every row carries a literal `metric` column naming its query (`sqlite3 -json`
drops the `-- name:` comments), so the output is self-labeled. Paste it into `lab/calibrate/rates.json` under `"queries"`, then add by
hand, from your models.yaml and policies.yaml, provider/model names and
non-personal policy values only:

    { "queries": { ... },
      "models": { "reasoning": { "provider": "...", "model": "..." }, ... },
      "policies": { "biographer": { "domainGating": true } } }

`rates.json` is gitignored.
