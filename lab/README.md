# Robin test lab

Replays a synthetic life (generated from a seed, no real data) through a sandboxed copy of
Robin's memory pipeline, one sim-day at a time, then scores the resulting beliefs against
what a perfect memory could know. Arms differ by tuning; the same fixture feeds every arm.

```
pnpm lab doctor                                   # environment + isolation checks (exit 1 on failure)
pnpm lab fixture --seed N --days D [--out DIR]    # default out: lab/fixtures/<seed>-<days>d
pnpm lab copy --fixture DIR --arm FILE.json [--out lab/runs] [--inline] [--days N]
pnpm lab score --copy lab/runs/<arm> --fixture DIR
```

An arm file is `{"name": "baseline"}` or e.g. `{"name": "gate-3d", "tuning": {"promoteAgeDays": 3}}`;
an optional `"steps"` array overrides the dream steps. Arm names are kebab-case.
`copy` runs each sim-day in a fresh child process unless `--inline` is given.

Outputs go to `lab/fixtures/` and `lab/runs/` (both gitignored). Each run directory
(`lab/runs/<arm>`) holds `run.json`, `results.jsonl`, `snapshots/` (every 7th sim-day and the
last) and, after `score`, `score.json`.

Template mode only: a deterministic in-process provider answers every prompt, with no network
and no paid calls. There is no paid mode yet.

Lab tests run under `pnpm test`. `lab/lint.test.ts` fails if lab code imports the MCP/HTTP
surfaces, the scheduler, the cognition runner entry or the paid agent provider, or mentions
`loadEnvFile` (the live secrets loader).

`lab/calibrate/` is the one script the operator runs by hand (aggregate SQL against their own
data); nothing else in the lab reads `user-data/`.
