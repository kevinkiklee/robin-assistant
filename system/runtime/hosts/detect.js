import { claudeCodeAdapter } from './claude-code.js';
import { geminiAdapter } from './gemini.js';

// Canonical hyphenated names: 'claude-code', 'gemini-cli'.
const ADAPTERS = {
  'claude-code': claudeCodeAdapter,
  'gemini-cli': geminiAdapter,
};

// Back-compat: accept legacy underscored ROBIN_HOST inputs and route them
// to the canonical hyphenated form. The first underscored hit logs a
// one-shot deprecation warning.
const ROBIN_HOST_ALIASES = {
  claude_code: 'claude-code',
  gemini_cli: 'gemini-cli',
};

let warnedUnderscoreOverride = false;

export async function detectHost(opts = {}) {
  const raw = process.env.ROBIN_HOST;
  if (raw) {
    let key = raw;
    if (ROBIN_HOST_ALIASES[raw]) {
      key = ROBIN_HOST_ALIASES[raw];
      if (!warnedUnderscoreOverride) {
        console.warn(
          `[hosts] ROBIN_HOST=${raw} is deprecated; use the hyphenated form '${key}' instead.`,
        );
        warnedUnderscoreOverride = true;
      }
    }
    if (ADAPTERS[key]) return ADAPTERS[key];
  }

  // Heuristics
  if (process.env.CLAUDE_PROJECT_DIR) return claudeCodeAdapter;
  if (process.env.GEMINI_API_KEY) return geminiAdapter;

  // Last-resort: probe availability (skipped in tests via skipAvailabilityCheck)
  if (!opts.skipAvailabilityCheck) {
    if (await claudeCodeAdapter.isAvailable()) return claudeCodeAdapter;
    if (await geminiAdapter.isAvailable()) return geminiAdapter;
  }

  throw new Error(
    'no host detected: set ROBIN_HOST=claude-code|gemini-cli or install one of the host CLIs',
  );
}
