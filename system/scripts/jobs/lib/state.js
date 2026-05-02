// Per-job state JSON readers/writers + index/upcoming/failures regen.

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readJSON, writeIfChanged, writeJSONIfChanged } from './atomic.js';
import { jobsPaths } from './paths.js';
import { parseCron, cronNext, expectedIntervalMs, inActiveWindow } from './cron.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function readJobState(workspaceDir, name) {
  return readJSON(jobsPaths(workspaceDir).stateJSON(name), null);
}

export function writeJobState(workspaceDir, name, state) {
  return writeJSONIfChanged(jobsPaths(workspaceDir).stateJSON(name), state);
}

export function listJobStates(workspaceDir) {
  const paths = jobsPaths(workspaceDir);
  if (!existsSync(paths.stateDir)) return new Map();
  const out = new Map();
  for (const f of readdirSync(paths.stateDir)) {
    if (!f.endsWith('.json')) continue;
    if (f.startsWith('.')) continue;
    const name = f.slice(0, -5);
    const s = readJSON(join(paths.stateDir, f), null);
    if (s) out.set(name, s);
  }
  return out;
}

export function deleteJobState(workspaceDir, name) {
  const paths = jobsPaths(workspaceDir);
  for (const suffix of ['.json']) {
    const p = join(paths.stateDir, name + suffix);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}

// Format a Date for human surfaces in the user's configured timezone.
// Falls back to system local time if tz is missing.
export function formatLocal(date, tz, opts = {}) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || undefined,
    year: opts.year ? 'numeric' : undefined,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: opts.tz ? 'short' : undefined,
  });
  // en-CA gives YYYY-MM-DD HH:mm; we re-shape to MM-DD HH:mm to save tokens.
  const parts = fmt.formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const mm = get('month');
  const dd = get('day');
  const hh = get('hour');
  const mi = get('minute');
  const tzn = get('timeZoneName');
  let s = `${mm}-${dd} ${hh}:${mi}`;
  if (opts.year) s = `${get('year')}-${s}`;
  if (opts.tz && tzn) s += ` ${tzn}`;
  return s;
}

function statusForIndex(state) {
  if (!state) return '—';
  if (state.last_status) return state.last_status;
  return '—';
}

// Generate INDEX.md content from the union of effective jobs and their states.
export function renderIndex({ jobs, states, generatedAt = new Date(), tz = null }) {
  const enabled = [];
  const disabled = [];
  for (const [name, def] of jobs) {
    const en = def.frontmatter.enabled !== false;
    const row = { name, def, state: states.get(name) || null };
    if (en) enabled.push(row);
    else disabled.push(row);
  }
  enabled.sort((a, b) => a.name.localeCompare(b.name));
  disabled.sort((a, b) => a.name.localeCompare(b.name));

  const failedIn24h = enabled.filter((r) => {
    if (!r.state || r.state.last_status !== 'failed') return false;
    const t = r.state.last_run_at && new Date(r.state.last_run_at).getTime();
    return t && Date.now() - t < ONE_DAY_MS;
  });

  const outOfWindowToday = enabled.filter(
    (r) => r.def.frontmatter.active && !inActiveWindow(r.def.frontmatter.active, new Date())
  );

  const lines = [];
  lines.push('# Jobs Index');
  lines.push(
    `Generated ${generatedAt.toISOString()} · ${jobs.size} jobs · ${enabled.length} enabled · ${failedIn24h.length} failed in 24h · ${outOfWindowToday.length} out-of-window today`
  );
  lines.push('');
  lines.push('| Name | Runtime | Status | Last Run | Next |');
  lines.push('|------|---------|--------|----------|------|');
  for (const r of enabled) {
    const lastRun = r.state && r.state.last_run_at ? formatLocal(r.state.last_run_at, tz) : '—';
    const next = r.state && r.state.next_run_at ? formatLocal(r.state.next_run_at, tz) : '—';
    lines.push(
      `| ${r.name} | ${r.def.frontmatter.runtime} | ${statusForIndex(r.state)} | ${lastRun} | ${next} |`
    );
  }
  lines.push('');
  if (disabled.length > 0) {
    lines.push('## Disabled');
    lines.push(disabled.map((r) => r.name).join(', '));
    lines.push('');
  }
  lines.push('## Failed in last 24h');
  lines.push(failedIn24h.length === 0 ? '(none)' : failedIn24h.map((r) => r.name).join(', '));
  lines.push('');
  lines.push('## Out-of-window today');
  lines.push(outOfWindowToday.length === 0 ? '(none)' : outOfWindowToday.map((r) => r.name).join(', '));
  lines.push('');
  return lines.join('\n');
}

export function regenIndex(workspaceDir, jobs, states, opts = {}) {
  const content = renderIndex({ jobs, states, ...opts });
  return writeIfChanged(jobsPaths(workspaceDir).indexMd, content);
}

// failures.md — per-job grouped, derived entirely from state JSONs.
// `healthSection` (string, optional) is appended verbatim — typically the
// `## Health check` block produced by `renderHealthSection()` in doctor.js.
export function renderFailures({ jobs, states, generatedAt = new Date(), tz = null, healthSection = null }) {
  const active = [];
  const resolved = [];
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled === false) continue;
    const s = states.get(name);
    if (!s) continue;
    if (s.last_status === 'failed') {
      const since = s.failing_since || s.last_run_at;
      active.push({ name, since, count: s.consecutive_failures || 1, category: s.last_failure_category, error: s.last_error_line || '' });
    } else if (s.last_status === 'ok' && s.previously_failed_until) {
      // Resolved within last 7 days?
      const t = new Date(s.previously_failed_until).getTime();
      if (Date.now() - t < 7 * ONE_DAY_MS) {
        resolved.push({ name, resolvedAt: s.previously_failed_until, durationMs: s.previously_failed_duration_ms || 0 });
      }
    }
  }

  active.sort((a, b) => a.name.localeCompare(b.name));
  resolved.sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));

  const lines = [];
  lines.push('# Job Failures');
  lines.push(`Updated ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push("## Active (job's last run is failing)");
  if (active.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| Job | Since | Count | Category | Last reason |');
    lines.push('|-----|-------|-------|----------|-------------|');
    for (const r of active) {
      const since = formatLocal(r.since, tz, { tz: true });
      const reason = (r.error || '').replace(/\|/g, '\\|').slice(0, 200);
      lines.push(`| ${r.name} | ${since} | ${r.count} | ${r.category || '—'} | ${reason} |`);
    }
  }
  lines.push('');
  lines.push('## Resolved — last 7 days');
  if (resolved.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| Job | Resolved | Was failing for |');
    lines.push('|-----|----------|-----------------|');
    for (const r of resolved) {
      lines.push(`| ${r.name} | ${formatLocal(r.resolvedAt, tz, { tz: true })} | ${humanDuration(r.durationMs)} |`);
    }
  }
  lines.push('');
  if (healthSection) {
    lines.push(healthSection);
  }
  return lines.join('\n');
}

function humanDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}`;
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'}`;
  if (m >= 1) return `${m} min`;
  return `${s}s`;
}

export function regenFailures(workspaceDir, jobs, states, opts = {}) {
  const content = renderFailures({ jobs, states, ...opts });
  return writeIfChanged(jobsPaths(workspaceDir).failuresMd, content);
}

// upcoming.md — 7-day forward calendar by walking each enabled job's cron.
export function renderUpcoming({ jobs, generatedAt = new Date(), tz = null, days = 7 }) {
  const horizon = new Date(generatedAt.getTime() + days * ONE_DAY_MS);
  const events = [];
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled === false) continue;
    if (!def.frontmatter.schedule) continue;
    let cron;
    try {
      cron = parseCron(def.frontmatter.schedule);
    } catch {
      continue;
    }
    let cursor = generatedAt;
    let safety = 200;
    while (safety-- > 0) {
      const next = cronNext(cron, cursor);
      if (!next || next > horizon) break;
      if (inActiveWindow(def.frontmatter.active, next)) {
        events.push({ name, when: next });
      }
      cursor = next;
    }
  }
  events.sort((a, b) => a.when - b.when);

  const groups = new Map();
  for (const e of events) {
    const dayKey = e.when.toISOString().slice(0, 10);
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push(e);
  }

  const lines = [];
  lines.push('# Upcoming Job Runs');
  const tzLabel = tz || 'OS local';
  lines.push(`Generated ${generatedAt.toISOString()} · ${tzLabel} · next ${days} days`);
  lines.push('');
  if (events.length === 0) {
    lines.push('(no scheduled runs)');
    lines.push('');
    return lines.join('\n');
  }
  const today = generatedAt.toISOString().slice(0, 10);
  for (const [dayKey, items] of groups) {
    const isToday = dayKey === today;
    const dt = new Date(dayKey + 'T00:00:00Z');
    const label = isToday
      ? `today (${weekday(dt)} ${dayKey})`
      : `${weekday(dt)} ${dayKey}`;
    lines.push(`## ${label}`);
    for (const e of items) {
      const hhmm = formatLocal(e.when, tz).slice(-5); // "HH:MM"
      lines.push(`- ${hhmm}  ${e.name}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function weekday(date) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
}

export function regenUpcoming(workspaceDir, jobs, opts = {}) {
  const content = renderUpcoming({ jobs, ...opts });
  return writeIfChanged(jobsPaths(workspaceDir).upcomingMd, content);
}

// Compute next_run_at for one effective def. Returns ISO string or null.
export function computeNextRun(def, from = new Date()) {
  if (!def.frontmatter.schedule) return null;
  let cron;
  try {
    cron = parseCron(def.frontmatter.schedule);
  } catch {
    return null;
  }
  const horizon = 365 * ONE_DAY_MS;
  let cursor = from;
  let safety = 1000;
  while (safety-- > 0) {
    const next = cronNext(cron, cursor);
    if (!next || next.getTime() - from.getTime() > horizon) return null;
    if (inActiveWindow(def.frontmatter.active, next)) return next.toISOString();
    cursor = next;
  }
  return null;
}

// Log rotation: prune log files older than maxAgeMs across all jobs.
export function rotateLogs(workspaceDir, maxAgeMs = 30 * ONE_DAY_MS, now = Date.now()) {
  const paths = jobsPaths(workspaceDir);
  if (!existsSync(paths.logsDir)) return 0;
  let pruned = 0;
  for (const f of readdirSync(paths.logsDir)) {
    const p = join(paths.logsDir, f);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > maxAgeMs) {
        unlinkSync(p);
        pruned++;
      }
    } catch {
      // ignore
    }
  }
  return pruned;
}

export { expectedIntervalMs };
