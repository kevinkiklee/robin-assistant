// Codex CLI transcript parser.
//
// codex --json emits JSONL events; tool calls have shape:
//   {"type":"tool_call","tool":"shell","arguments":{"command":["cat","path"]}}
// or with the file-tool variant. This parser extracts Read/Write equivalents.

export function parseCodex(text) {
  const reads = [];
  const writes = [];
  const assistant = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (evt.type === 'tool_call' || evt.type === 'function_call') {
      const tool = evt.tool ?? evt.name;
      const args = evt.arguments ?? evt.input ?? {};

      if (tool === 'shell' || tool === 'bash') {
        const cmd = Array.isArray(args.command) ? args.command : [args.command];
        const joined = cmd.filter(Boolean).join(' ');
        // Heuristic: cat / less / head / tail with a single arg = read
        const readMatch = joined.match(/^\s*(?:cat|less|head|tail|bat)\s+([^\s|>;&]+)/);
        if (readMatch) reads.push(normalizePath(readMatch[1]));
        // > / >> redirect or `tee` = write
        const writeRedirect = joined.match(/(?:^|\s)>>?\s+(\S+)/);
        const writeTee = joined.match(/(?:^|;|&&|\|\||\s)tee\s+(\S+)/);
        if (writeRedirect) writes.push(normalizePath(writeRedirect[1]));
        if (writeTee) writes.push(normalizePath(writeTee[1]));
      } else if (tool === 'read_file' || tool === 'Read') {
        const path = args.path ?? args.file_path;
        if (path) reads.push(normalizePath(path));
      } else if (tool === 'write_file' || tool === 'Write' || tool === 'Edit') {
        const path = args.path ?? args.file_path;
        if (path) writes.push(normalizePath(path));
      }
    }

    if (evt.type === 'message' && evt.role === 'assistant') {
      if (typeof evt.content === 'string') assistant.push(evt.content);
    }
  }

  return { reads, writes, assistant: assistant.join('\n') };
}

function normalizePath(p) {
  return p.replace(/^\/.*?\/robin-assistant\//, '').replace(/^\.\//, '');
}
