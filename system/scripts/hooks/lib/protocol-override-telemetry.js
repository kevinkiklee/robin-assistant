// JSONL telemetry for the pre-protocol-override hook.
//
// Schema (per spec):
//   { ts, session, event, protocol, ... }  where event ∈ { injected, blocked, hook_error }
//
// File: <workspace>/user-data/runtime/state/telemetry/protocol-override-enforcement.log
//
// Failures are silent — telemetry must never break enforcement.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LOG_REL = 'user-data/runtime/state/telemetry/protocol-override-enforcement.log';

export function appendTelemetry(workspace, entry) {
  try {
    const file = join(workspace, LOG_REL);
    mkdirSync(dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    appendFileSync(file, line + '\n');
  } catch {
    // Silent — never break enforcement on telemetry failure.
  }
}
