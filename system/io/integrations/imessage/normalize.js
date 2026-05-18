// Pure helpers for the iMessage bridge. No I/O, no Node-specific APIs
// beyond standard library, so unit-testable without fixtures.

// Apple stores `message.date` as nanoseconds since the Mac epoch
// (2001-01-01 00:00:00 UTC). Convert to a regular Date.
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);

export function appleDateToJsDate(nanos) {
  if (nanos == null) return null;
  const n = typeof nanos === 'bigint' ? nanos : BigInt(nanos);
  // Pre-Catalina rows were stored as seconds; the cutover yields some rows
  // with absurdly small values. Heuristic: if < 1e15 treat as seconds.
  const ms = n < 1_000_000_000_000_000n ? Number(n) * 1000 : Number(n / 1_000_000n);
  return new Date(MAC_EPOCH_MS + ms);
}

// Handles in chat.db can be:
//   "+15551234567"        — phone number (E.164)
//   "user@example.com"    — email (Apple ID iMessage)
//   "e:user@example.com"  — email-prefixed (older rows)
// Normalize to a stable lower-case form without the e: prefix.
export function normalizeHandle(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.toLowerCase();
  if (s.startsWith('e:')) s = s.slice(2);
  return s;
}

// chat.style: 43 = group, 45 = direct (per Apple's enum, observed in 2025+).
export function isGroupChat(style) {
  return Number(style) === 43;
}

// chat.service_name: 'iMessage' or 'SMS'. Continuity-forwarded SMS shows up
// in chat.db with service_name='SMS'. We surface both as iMessage from the
// agent's perspective; the source field disambiguates if needed.
export function classifyService(serviceName) {
  const s = String(serviceName ?? '').toLowerCase();
  if (s === 'imessage') return 'imessage';
  if (s === 'sms') return 'sms-continuity';
  return s || 'unknown';
}

// Determine whether a row from the polled join should be skipped because we
// authored it (avoid double-processing our own sent messages).
export function isFromMe(row) {
  return row?.is_from_me === 1 || row?.is_from_me === true;
}

// Allowlist matching:
//   - directHandles: Set of normalized handles allowed in DM
//   - groupChats:    Set of chat GUIDs allowed (any member's messages)
//
// A message is allowed if:
//   - It's a DM (chat.style != 43) AND the sender handle is in directHandles, OR
//   - It's in a group AND the chat GUID is in groupChats
export function isAllowed(row, allowlist) {
  if (!row || !allowlist) return false;
  if (isGroupChat(row.chat_style)) {
    return allowlist.groupChats?.has(row.chat_guid) === true;
  }
  return allowlist.directHandles?.has(normalizeHandle(row.handle)) === true;
}
