import { claudeCodeAdapter } from './claude-code.js';
import { geminiAdapter } from './gemini.js';

const ADAPTERS = {
  claude_code: claudeCodeAdapter,
  gemini_cli: geminiAdapter,
};

export async function detectHost(opts = {}) {
  // Explicit override wins (only if it names a known adapter)
  const override = process.env.ROBIN_HOST;
  if (override && ADAPTERS[override]) {
    return ADAPTERS[override];
  }

  // Heuristics
  if (process.env.CLAUDE_PROJECT_DIR) return claudeCodeAdapter;
  // GEMINI_API_KEY is a strong signal someone wants Gemini even though Path A doesn't need it
  if (process.env.GEMINI_API_KEY) return geminiAdapter;

  // Last-resort: probe availability (skipped in tests via skipAvailabilityCheck)
  if (!opts.skipAvailabilityCheck) {
    if (await claudeCodeAdapter.isAvailable()) return claudeCodeAdapter;
    if (await geminiAdapter.isAvailable()) return geminiAdapter;
  }

  throw new Error(
    'no host detected: set ROBIN_HOST=claude_code|gemini_cli or install one of the host CLIs',
  );
}
