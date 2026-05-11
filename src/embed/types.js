/**
 * @typedef {'mxbai-1024' | 'qwen3-4096' | 'gemini-3072'} EmbedderProfile
 *
 * @typedef {Object} Embedder
 * @property {EmbedderProfile} profile
 * @property {1024 | 4096 | 3072} dimension
 * @property {string} modelId
 * @property {(text: string) => Promise<Float32Array>} embed
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedBatch
 * @property {() => Promise<void>} healthCheck
 * @property {(() => Promise<void>) | undefined} unload
 */
export {};
