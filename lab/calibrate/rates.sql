-- name: window
SELECT 'window' AS metric,
       MIN(substr(ts, 1, 10)) IS NOT NULL AS has_events,
       CAST(julianday(MAX(ts)) - julianday(MIN(ts)) AS INTEGER) AS span_days,
       COUNT(*) AS events_total
FROM events;

-- name: events_per_day_by_kind
SELECT 'events_per_day_by_kind' AS metric,
       CASE WHEN instr(kind, '.') > 0 THEN substr(kind, 1, instr(kind, '.') - 1) ELSE kind END AS kind_prefix,
       ROUND(COUNT(*) * 1.0 / (SELECT MAX(1, julianday(MAX(ts)) - julianday(MIN(ts))) FROM events), 3) AS per_day
FROM events
GROUP BY kind_prefix
ORDER BY per_day DESC;

-- name: sessions_per_day
SELECT 'sessions_per_day' AS metric,
       ROUND(COUNT(*) * 1.0 / (SELECT MAX(1, julianday(MAX(ts)) - julianday(MIN(ts))) FROM events), 3) AS per_day
FROM events
WHERE kind = 'session.captured';

-- name: corrections_per_month
SELECT 'corrections_per_month' AS metric,
       substr(ts, 1, 7) AS month, COUNT(*) AS n
FROM corrections
GROUP BY month
ORDER BY month;

-- name: supersessions_per_topic
SELECT 'supersessions_per_topic' AS metric,
       CASE WHEN n = 1 THEN '1' WHEN n = 2 THEN '2' WHEN n = 3 THEN '3'
            WHEN n <= 5 THEN '4-5' ELSE '6+' END AS bucket,
       COUNT(*) AS topics
FROM (SELECT json_extract(payload, '$.topic') AS t, COUNT(*) AS n
      FROM events WHERE kind = 'belief.update' GROUP BY t)
GROUP BY bucket
ORDER BY bucket;

-- name: candidate_status
SELECT 'candidate_status' AS metric,
       status, COUNT(*) AS n
FROM belief_candidates
GROUP BY status;

-- name: candidate_days_to_resolve
SELECT 'candidate_days_to_resolve' AS metric,
       status,
       ROUND(AVG(julianday(resolved_at) - julianday(created_at)), 2) AS mean_days,
       COUNT(*) AS n
FROM belief_candidates
WHERE resolved_at IS NOT NULL
GROUP BY status;

-- name: filler_session_share
SELECT 'filler_session_share' AS metric,
       CASE WHEN COUNT(DISTINCT e.id) = 0 THEN NULL
            ELSE ROUND(1.0 - COUNT(DISTINCT bc.source_event_id) * 1.0 / COUNT(DISTINCT e.id), 3) END AS share
FROM events e
LEFT JOIN belief_candidates bc ON bc.source_event_id = e.id
WHERE e.kind = 'session.captured';
