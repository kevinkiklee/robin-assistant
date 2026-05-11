import { claudeCodeAdapter } from './claude-code.js';
import { geminiAdapter } from './gemini.js';

// Keys remain underscored — they match adapter.name and many existing call
// sites (e.g., install/hooks-settings.js uses `${host.name}-hooks` as a
// settings.json key; events.meta.host carries underscored values). The full
// repo-wide rename is deferred to a separate cleanup PR with explicit
// settings.json migration.
const ADAPTERS = {
  claude_code: claudeCodeAdapter,
  gemini_cli: geminiAdapter,
};

// Accept both hyphenated (canonical going forward) and underscored (legacy)
// forms of ROBIN_HOST. Internally we still look up by underscored key.
const ROBIN_HOST_ALIASES = {
  'claude-code': 'claude_code',
  'gemini-cli': 'gemini_cli',
  // identity aliases for legacy callers
  claude_code: 'claude_code',
  gemini_cli: 'gemini_cli',
};

let warnedUnderscoreOverride = false;

export async function detectHost(opts = {}) {
  const raw = process.env.ROBIN_HOST;
  if (raw) {
    const internal = ROBIN_HOST_ALIASES[raw];
    if (internal) {
      if ((raw === 'claude_code' || raw === 'gemini_cli') && !warnedUnderscoreOverride) {
        console.warn(
          `[hosts] ROBIN_HOST=${raw} is deprecated; use the hyphenated form '${raw.replace('_', '-')}' instead.`,
        );
        warnedUnderscoreOverride = true;
      }
      return ADAPTERS[internal];
    }
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
