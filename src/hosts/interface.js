/**
 * @typedef {Object} InvokeLLMOpts
 * @property {'fast' | 'balanced' | 'deep'} [tier]
 * @property {Array<{role: string, content: string, cache_control?: { type: 'ephemeral' }}>} [system]
 * @property {boolean} [json]
 * @property {number} [maxTokens]
 * @property {number} [cacheVersion]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} InvokeLLMResult
 * @property {string} content
 * @property {{ input_tokens: number, output_tokens: number, cache_read_tokens?: number, cache_write_tokens?: number }} usage
 */

/**
 * @typedef {Object} HostAdapter
 * @property {string} name
 * @property {() => Promise<boolean>} isAvailable
 * @property {(messages: Array<{role: string, content: string}>, opts?: InvokeLLMOpts) => Promise<InvokeLLMResult>} invokeLLM
 */

// Tier→model mapping per provider. Adapters use these when opts.tier is set.
export const CLAUDE_TIER_MAP = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-7',
};

export const GEMINI_TIER_MAP = {
  fast: 'gemini-2.5-flash-lite',
  balanced: 'gemini-2.5-flash',
  deep: 'gemini-2.5-pro',
};

export const DEFAULT_TIER = 'fast';
