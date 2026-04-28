// Failure-category detection from exit code + rolling stderr buffer.

const AUTH_RE = /\b(401|403|Unauthorized|invalid[\s_-]?token|session[\s_-]?expired|please[\s_-]+log[\s_-]?in|authentication[\s_-]+(failed|required))\b/i;
const NOT_FOUND_RE = /\b(command not found|No such file or directory)\b/i;

export function categorizeFailure({ exitCode, signal, stderrTail = '', kind = null } = {}) {
  if (kind === 'timeout' || signal === 'SIGTERM' || signal === 'SIGKILL') {
    return 'timeout';
  }
  if (exitCode === 0) return null;
  if (exitCode === 2) return 'definition_invalid';
  if (exitCode === 3) return 'internal';
  if (exitCode === 127 || NOT_FOUND_RE.test(stderrTail)) return 'command_not_found';
  if (AUTH_RE.test(stderrTail)) return 'auth_expired';
  if (exitCode === 1) return 'runtime_error';
  return 'unknown';
}

// Notification dedup: should we notify on this failure given prior state?
// Rules:
//   1. Notify on (job, category) status transitions.
//   2. auth_expired global 6h debounce across all jobs.
//   3. notify_on_failure: false on the job → never notify.
//   4. ROBIN_NO_NOTIFY env → never notify.
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function shouldNotify({
  jobName,
  category,
  notifyOnFailure = true,
  envSuppressed = false,
  state = {},
  now = Date.now(),
}) {
  if (envSuppressed) return false;
  if (notifyOnFailure === false) return false;
  if (!category) return false;
  const last = state.last_notified || {};
  const jobKey = `${jobName}:${category}`;
  const globalKey = `*:${category}`;
  if (category === 'auth_expired') {
    const lastGlobal = last[globalKey];
    if (lastGlobal && now - new Date(lastGlobal).getTime() < SIX_HOURS_MS) return false;
    return true;
  }
  // Same (job, category) repeated → suppress; new category → notify.
  if (last[jobKey]) return false;
  return true;
}

export function recordNotification({ jobName, category, state = {}, now = new Date() }) {
  const out = { ...state };
  out.last_notified = { ...(state.last_notified || {}) };
  out.last_notified[`${jobName}:${category}`] = now.toISOString();
  if (category === 'auth_expired') {
    out.last_notified[`*:${category}`] = now.toISOString();
  }
  return out;
}

// Clear dedup keys for a job — used when re-enabling or when a fresh parse
// succeeds for a previously definition_invalid job.
export function clearDedupForJob(state = {}, jobName) {
  const out = { ...state };
  out.last_notified = { ...(state.last_notified || {}) };
  for (const key of Object.keys(out.last_notified)) {
    if (key.startsWith(`${jobName}:`)) delete out.last_notified[key];
  }
  return out;
}

export function notificationText({ jobName, category, errorLine = '' }) {
  const truncatedError = (errorLine || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  let title = `Robin: ${jobName} failed`;
  let body;
  switch (category) {
    case 'auth_expired':
      body = `agent CLI auth expired — run \`claude login\` (or your CLI's equivalent)`;
      break;
    case 'command_not_found':
      body = `command not found — install your agent CLI and run \`robin jobs sync\``;
      break;
    case 'timeout':
      body = `job exceeded its timeout`;
      break;
    case 'definition_invalid':
      body = `job definition is invalid: ${truncatedError}`;
      break;
    case 'internal':
      body = `runner internal error: ${truncatedError}`;
      break;
    default:
      body = `${category}: ${truncatedError}`.slice(0, 200);
  }
  return { title, body };
}
