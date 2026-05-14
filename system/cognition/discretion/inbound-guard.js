import { checkInbound } from './pii-patterns.js';
import { logRefusal } from './refusal-log.js';

// Inbound discretion guard. Designed to be passed as `guard` to recordEvent.
// Returns {ok:true} on clean text. On match, records a `refusals` row with
// direction='inbound' and returns {ok:false, reason}.
//
// The shared `logRefusal` helper redacts the payload at write time when the
// match is for PII or a credential, so the raw secret never lands in the
// `refusals` table (which is read by the `recent_refusals` MCP tool and the
// `robin refusals list` command).
export async function guardInboundContent(db, content) {
  const result = checkInbound(content);
  if (result.ok) return { ok: true };
  await logRefusal(db, {
    direction: 'inbound',
    destination: 'memory',
    reason: result.reason,
    payload: content,
  });
  return result;
}
