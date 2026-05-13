-- 0024-scheduler-driven.surql — add `scheduler_driven` flag to runtime_jobs.
--
-- A scheduler_driven job is documented + UPSERTed into the registry so it
-- shows up in `robin jobs list`, but the generic jobs dispatcher in
-- `cognition/jobs/scheduler-ext.js → listDueJobs` skips it. The actual cadence
-- is owned by a dedicated heartbeat bucket in `runtime/daemon/server.js`
-- (currently used by state-inference, which needs an embedder handle the
-- generic runner doesn't thread through).
--
-- Defaults to false so existing jobs are unaffected.

DEFINE FIELD scheduler_driven ON runtime_jobs TYPE bool DEFAULT false;
