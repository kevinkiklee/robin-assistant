// Build a minimal explicit env for spawn(). Cycle-2a: subprocesses no longer
// inherit secrets via process.env (because secrets.js no longer pollutes env),
// but spawn-time scrubbing is the second-line defense — every spawn call
// passes safeEnv() so even if env state ever drifts, only an allowlisted
// set of variables reaches the child.

const SAFE_ENV_KEYS = [
  'HOME',
  'PATH',
  'USER',
  'LANG',
  'TERM',
  'TMPDIR',
  'NODE_PATH',
  'ROBIN_WORKSPACE',
  'ROBIN_AGENT_COMMAND',
  'ROBIN_BIN',
  'ROBIN_NO_NOTIFY',
  'ROBIN_AUTO_MEMORY_DIR',
  'ROBIN_DRAIN_SYNC',
  // Locale is needed for some CLIs (e.g., date formatting in claude).
  'LC_ALL',
  'LC_CTYPE',
  // Display / WAYLAND for desktop notifiers.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
];

export function safeEnv(extras = {}) {
  const out = {};
  for (const k of SAFE_ENV_KEYS) {
    if (k in process.env) out[k] = process.env[k];
  }
  return { ...out, ...extras };
}

export function listSafeEnvKeys() {
  return [...SAFE_ENV_KEYS];
}
