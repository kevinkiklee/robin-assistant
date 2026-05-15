// Hand-curated policy lists. Audited by unit test: every name here must
// resolve to a real invariant in the registry.

export const BOOT_REPAIR_ALLOWLIST = ['install.pointer_present'];

export const CLI_BLOCKING_SET = ['install.pointer_present', 'mcp.wiring_project_present'];

export const PHASES = ['paths', 'db', 'mcp', 'integrations', 'runtime', 'meta'];

export const LEVELS = ['critical', 'warn', 'info'];
