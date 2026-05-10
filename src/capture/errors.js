// Error class thrown by recordEvent (and downstream MCP memory-write tools)
// when the inbound PII guard refuses content.
//
// MCP tool handlers throw this; the daemon's CallToolRequest wrapper surfaces
// the .message back to the calling agent. Use `robin remember --force` (CLI
// only) to bypass — agents have no in-band override.

export class RobinPiiRefusedError extends Error {
  constructor(reason, message) {
    super(
      message ??
        `Robin: refused to store memory — ${reason}. Use \`robin remember --force\` if intentional.`,
    );
    this.name = 'RobinPiiRefusedError';
    this.reason = reason;
  }
}
