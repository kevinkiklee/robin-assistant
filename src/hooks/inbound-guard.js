import { createHash } from 'node:crypto';
import { surql } from 'surrealdb';
import { checkInbound } from './pii-patterns.js';

// Mirrors logRefusal in src/outbound/policy.js, but tags direction='inbound'
// and destination='memory' for discretion refusals on memory-write handlers.
async function logInboundRefusal(db, reason, payload) {
  const payload_hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  await db
    .query(
      surql`CREATE refusals CONTENT ${{
        destination: 'memory',
        reason,
        payload_hash,
        direction: 'inbound',
      }}`,
    )
    .collect();
}

// Inbound discretion guard. Designed to be passed as `guard` to recordEvent.
// Returns {ok:true} on clean text. On match, records a `refusals` row with
// direction='inbound' and returns {ok:false, reason}.
export async function guardInboundContent(db, content) {
  const result = checkInbound(content);
  if (result.ok) return { ok: true };
  await logInboundRefusal(db, result.reason, content);
  return result;
}
