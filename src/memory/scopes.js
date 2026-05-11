// scopes.js — SCOPE constants and conventions for memos/events/entities/episodes.
// Spec §5.4. Convention: persistent scopes are kept indefinitely; ephemeral
// scopes (session:*, temp:*) are pruned by dream/step-scope-cleanup unless
// referenced (derived_from) by a non-ephemeral memo.

export const SCOPE = {
  GLOBAL: 'global',
  PRIVATE: 'private',
  project: (name) => `project:${name}`,
  session: (id) => `session:${id}`,
  integration: (name) => `integration:${name}`,
  temp: (reason) => `temp:${reason}`,
};

export const EPHEMERAL_SCOPE_PREFIXES = ['session:', 'temp:'];

export function isEphemeralScope(scope) {
  if (typeof scope !== 'string') return false;
  for (const p of EPHEMERAL_SCOPE_PREFIXES) {
    if (scope.startsWith(p)) return true;
  }
  return false;
}
