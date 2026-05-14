// refusal-log.js — shared writer for the refusals table.
//
// A single helper so inbound (pii-patterns guard) and outbound (PII / secret /
// untrusted-quote / private-scope) refusals stay consistent.
//
// Privacy invariant: when the refusal reason itself indicates that the payload
// contains a credential or piece of PII, the raw payload MUST NOT be persisted.
// The hash + length + reason are enough for correlation and forensics; storing
// the actual secret turns the refusals table into a leak surface (it's read by
// `recent_refusals` MCP, `robin refusals list`, and anyone with DB access).

import { createHash } from 'node:crypto';
import { surql } from 'surrealdb';

const REDACTED_PLACEHOLDER = '<redacted>';

function isSensitiveReason(reason) {
  return typeof reason === 'string' && (reason.startsWith('pii:') || reason.startsWith('secret:'));
}

function preparedContent(reason, payload) {
  if (isSensitiveReason(reason)) {
    const len = typeof payload === 'string' ? payload.length : 0;
    return `${REDACTED_PLACEHOLDER} (len=${len})`;
  }
  return payload;
}

/**
 * Append a refusal row.
 *
 * @param {object} db   SurrealDB client.
 * @param {object} args
 * @param {'inbound'|'outbound'} args.direction
 * @param {string} args.reason     e.g. 'pii:credit_card', 'secret:openai_key',
 *                                 'untrusted_quote', 'private_scope'.
 * @param {string} args.destination 'memory' for inbound; tool/dest for outbound.
 * @param {string} args.payload    The text that was about to be sent/written.
 * @param {string} [args.tool]     Optional tool tag for outbound writers.
 */
export async function logRefusal(db, { direction, reason, destination, payload, tool }) {
  const text = typeof payload === 'string' ? payload : String(payload ?? '');
  const payload_hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const content = preparedContent(reason, text);
  const row = {
    content,
    reason,
    direction,
    meta: { destination, payload_hash },
  };
  if (tool) row.tool = tool;
  await db.query(surql`CREATE refusals CONTENT ${row}`).collect();
}
