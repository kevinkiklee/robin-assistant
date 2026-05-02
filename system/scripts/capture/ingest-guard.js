// Ingest guard — refuses ingest's multi-file writes to high-impact destinations.
//
// Cycle-1a's ingest destination blocklist (G-15). Ingest is a direct-write
// exception (per system/rules/capture.md) that bypasses inbox routing. Without
// this guard, an attacker who plants instructions in an ingested document
// could cause ingest to write tasks, decisions, corrections, or patterns
// directly. The blocklist forbids those high-impact destinations.

export class IngestForbiddenError extends Error {
  constructor(path) {
    super(
      `INGEST_FORBIDDEN_DESTINATION: ingest cannot write to ${path}. ` +
      `If this is a knowledge update Kevin requested out-of-band, use a ` +
      `direct edit, not ingest.`
    );
    this.name = 'IngestForbiddenError';
    this.path = path;
  }
}

const FORBIDDEN_PATHS = [
  'user-data/memory/tasks.md',
  'user-data/memory/decisions.md',
  'user-data/memory/self-improvement/corrections.md',
  'user-data/memory/self-improvement/preferences.md',
  'user-data/memory/self-improvement/patterns.md',
  'user-data/memory/self-improvement/communication-style.md',
  'user-data/memory/self-improvement/calibration.md',
  'user-data/memory/profile/identity.md',
];

function normalizeForCheck(path) {
  // Accept both relative (`user-data/memory/tasks.md`) and absolute paths.
  // Strip leading slashes and any workspace prefix; compare against the
  // FORBIDDEN_PATHS list as a tail match.
  const norm = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return norm;
}

export function isIngestDestinationAllowed(path) {
  const norm = normalizeForCheck(path);
  for (const forbidden of FORBIDDEN_PATHS) {
    if (norm === forbidden || norm.endsWith('/' + forbidden)) return false;
  }
  return true;
}

export function assertIngestDestinationAllowed(path) {
  if (!isIngestDestinationAllowed(path)) {
    throw new IngestForbiddenError(path);
  }
}

export function listForbiddenPaths() {
  return [...FORBIDDEN_PATHS];
}
