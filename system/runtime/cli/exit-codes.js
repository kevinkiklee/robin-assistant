// CLI exit code contract. Used by every `robin <subcmd>` command to
// communicate success / generic error / user error / precondition failure
// in a way scripts and shells can rely on. Pre-existing in-the-wild codes
// (e.g., `robin publish` exit 3 for missing secrets) align with these
// canonical values; nothing was renumbered to avoid breaking scripts.

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  USER_ERROR: 2,    // bad args, missing required flag
  PRECONDITION: 3,  // missing secret, daemon not running, install not pointed
});

const NAMES = new Map([
  [0, 'OK'],
  [1, 'ERROR'],
  [2, 'USER_ERROR'],
  [3, 'PRECONDITION'],
]);

export function describeExit(code) {
  return NAMES.get(code) ?? 'ERROR';
}
