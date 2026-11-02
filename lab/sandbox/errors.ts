// lab/sandbox/errors.ts
/** Any attempt by a lab copy to touch the live instance or the outside world. Never caught by lab code. */
export class LabIsolationError extends Error {
  override name = 'LabIsolationError';
}
