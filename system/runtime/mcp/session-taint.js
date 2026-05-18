// system/runtime/mcp/session-taint.js
//
// Per-MCP-session in-memory taint state. Marked when a tool returns any
// row with trust !== 'trusted' or derived_from_trust !== 'trusted'.
// Consulted by remember/ingest to decide whether the resulting event row
// should be written as trust='untrusted'.
//
// Session = MCP SSE-session lifetime (one Claude Code client connection).
// Cleared on disconnect from system/runtime/daemon/mcp-sse.js.

const state = new Map(); // sessionId -> { tainted, sources: Set<string> }

function ensure(sessionId) {
  let s = state.get(sessionId);
  if (!s) {
    s = { tainted: false, sources: new Set() };
    state.set(sessionId, s);
  }
  return s;
}

export function markTainted(sessionId, sourceId) {
  if (!sessionId) return; // null/undefined sessions can't be tracked safely
  const s = ensure(sessionId);
  s.tainted = true;
  if (sourceId) s.sources.add(String(sourceId));
}

export function getSessionTaint(sessionId) {
  if (!sessionId) return { tainted: false, sources: new Set() };
  return state.get(sessionId) ?? { tainted: false, sources: new Set() };
}

export function clearSession(sessionId) {
  if (!sessionId) return;
  state.delete(sessionId);
}

/** Test-only. */
export function __resetForTests() {
  state.clear();
}
