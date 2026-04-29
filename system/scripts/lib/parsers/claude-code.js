// Claude Code transcript parser.
//
// Claude Code's transcript format includes tool calls in JSON-ish blocks. This
// parser extracts Read/Write/Edit tool calls with their target paths.
//
// Input: raw transcript text. Output: { reads: [paths], writes: [paths], assistant: [text] }.

export function parseClaudeCode(text) {
  const reads = [];
  const writes = [];
  const assistant = [];

  // Match JSONL events (one event per line):
  //   {"type":"tool_use","name":"Read","input":{"file_path":"..."}}
  // Also tolerate Anthropic SDK shapes and Claude Code's --output-format=jsonl.
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Tolerate non-JSON lines (legacy/free-text transcripts handled below).
      continue;
    }

    // Tool calls
    const toolName = evt.name ?? evt.tool ?? evt.tool_name;
    const path = evt.input?.file_path ?? evt.path ?? evt.arguments?.file_path;
    if (toolName === 'Read' && path) reads.push(normalizePath(path));
    else if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') && path)
      writes.push(normalizePath(path));

    // Assistant text content
    if (evt.role === 'assistant' && typeof evt.content === 'string') assistant.push(evt.content);
    if (evt.type === 'text' && typeof evt.text === 'string') assistant.push(evt.text);
  }

  // Fallback: scan free-text transcripts for Read("...") / Edit("...") patterns.
  if (reads.length === 0 && writes.length === 0) {
    const readRe = /Read\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const writeRe = /(?:Write|Edit|NotebookEdit)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = readRe.exec(text)) !== null) reads.push(normalizePath(m[1]));
    while ((m = writeRe.exec(text)) !== null) writes.push(normalizePath(m[1]));
  }

  return { reads, writes, assistant: assistant.join('\n') };
}

function normalizePath(p) {
  // Strip leading absolute prefix down to repo-relative if present.
  // Hosts may emit absolute paths; we compare against repo-relative.
  return p.replace(/^\/.*?\/robin-assistant\//, '').replace(/^\.\//, '');
}
