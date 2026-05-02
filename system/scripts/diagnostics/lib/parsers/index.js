import { parseClaudeCode } from './claude-code.js';
import { parseCodex } from './codex.js';
import { parseGeminiCli } from './gemini-cli.js';

export const PARSERS = {
  'claude-code': parseClaudeCode,
  'codex': parseCodex,
  'gemini-cli': parseGeminiCli,
  // Cursor and Antigravity transcripts are produced manually (IDE-bound).
  // Their checklists ask the user to record reads/writes directly into a
  // structured JSON file that the validator reads.
  'cursor': parseManualJson,
  'antigravity': parseManualJson,
};

function parseManualJson(text) {
  const obj = JSON.parse(text);
  return {
    reads: obj.reads ?? [],
    writes: obj.writes ?? [],
    assistant: obj.assistant ?? '',
  };
}
