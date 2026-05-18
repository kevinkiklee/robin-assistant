// system/runtime/mcp/current-call.js
//
// AsyncLocalStorage store for the current MCP call's session ID.
// The MCP SSE handler runs each tool dispatch inside als.run({ sessionId })
// so that getSessionId() anywhere in the call-chain returns the correct
// transport.sessionId without threading it through every argument list.

import { AsyncLocalStorage } from 'node:async_hooks';

export const als = new AsyncLocalStorage();

/** Returns the sessionId for the currently-executing MCP tool call, or null. */
export function getSessionId() {
  return als.getStore()?.sessionId ?? null;
}
