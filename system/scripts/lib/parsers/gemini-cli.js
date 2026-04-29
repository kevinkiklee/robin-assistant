// Gemini CLI transcript parser.
//
// gemini -p emits its tool log to stderr. Format varies by version; this
// parser handles the `tool: <Name>(args)` shape and structured JSON events.

export function parseGeminiCli(text) {
  const reads = [];
  const writes = [];
  const assistant = [];

  // Structured JSONL path
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const tool = evt.tool ?? evt.name;
    const path = evt.args?.path ?? evt.input?.file_path ?? evt.path;
    if (tool === 'ReadFile' || tool === 'Read') reads.push(normalizePath(path));
    if (tool === 'WriteFile' || tool === 'Write' || tool === 'Edit') writes.push(normalizePath(path));
    if (evt.role === 'assistant' && evt.content) assistant.push(evt.content);
  }

  // Free-text fallback: `tool: ReadFile(path="...")`
  if (reads.length === 0 && writes.length === 0) {
    const readRe = /(?:ReadFile|Read)\(.*?(?:path|file_path)\s*=\s*["']([^"']+)["']/g;
    const writeRe = /(?:WriteFile|Write|Edit)\(.*?(?:path|file_path)\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = readRe.exec(text)) !== null) reads.push(normalizePath(m[1]));
    while ((m = writeRe.exec(text)) !== null) writes.push(normalizePath(m[1]));
  }

  return { reads, writes, assistant: assistant.join('\n') };
}

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/^\/.*?\/robin-assistant\//, '').replace(/^\.\//, '');
}
