/**
 * Single source of truth for the package version. Every surface (CLI, MCP
 * servers, daemon telemetry) should reference this constant rather than
 * hard-coding the string, so version bumps require exactly one edit
 * (here + package.json).
 */
export const VERSION = '3.0.0-alpha.0';
