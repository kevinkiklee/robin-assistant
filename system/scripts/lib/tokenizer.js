// Token-count estimation for the measure-tokens harness.
//
// Default heuristic: ceil(bytes / 3.7). Provider-neutral, deterministic, zero deps.
// Frontier-model tokenizers (Anthropic / OpenAI / Google) agree within ~10% on
// English markdown — close enough for budgeting and regression detection.
//
// Bytes is the primary metric (byte counts are exact). Tokens are derived.

const DEFAULT_BYTES_PER_TOKEN = 3.7;

export function countBytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function countLines(text) {
  if (text.length === 0) return 0;
  const trailing = text.endsWith('\n') ? 0 : 1;
  return text.split('\n').length - 1 + trailing;
}

export function estimateTokens(bytes, bytesPerToken = DEFAULT_BYTES_PER_TOKEN) {
  return Math.ceil(bytes / bytesPerToken);
}

export function measure(text) {
  const bytes = countBytes(text);
  return {
    bytes,
    lines: countLines(text),
    tokens: estimateTokens(bytes),
  };
}
