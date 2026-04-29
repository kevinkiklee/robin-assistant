// Gemini CLI transcript parser.
//
// Gemini CLI emits JSONL with shape:
//   {"type":"tool_use","tool_name":"read_file","parameters":{"file_path":"..."}}
//   {"type":"tool_use","tool_name":"run_shell_command","parameters":{"command":"cat foo.md"}}
//   {"type":"message","role":"assistant","content":"...","delta":true}
//
// Also supports older shapes (`tool`, `args`).

export function parseGeminiCli(text) {
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

    if (evt.type === 'tool_use') {
      const tool = evt.tool_name ?? evt.tool ?? evt.name;
      const params = evt.parameters ?? evt.args ?? evt.input ?? {};

      // Direct file tools
      if (tool === 'read_file' || tool === 'ReadFile' || tool === 'Read') {
        const p = params.file_path ?? params.path;
        if (p) reads.push(normalizePath(p));
      } else if (
        tool === 'write_file' ||
        tool === 'WriteFile' ||
        tool === 'Write' ||
        tool === 'Edit' ||
        tool === 'edit_file'
      ) {
        const p = params.file_path ?? params.path;
        if (p) writes.push(normalizePath(p));
      } else if (tool === 'run_shell_command' || tool === 'shell' || tool === 'bash') {
        // Heuristic: parse cat / tee / > / >> from the command string.
        // cat / head / tail / less / bat may have MANY file args:
        //   cat a.md b.md c.md
        // Grab everything after the verb up to a redirect / pipe / separator.
        const cmd = String(params.command ?? '');
        const readVerb = /(?:^|;|&&|\|\|)\s*(?:cat|less|head|tail|bat)\s+([^|>;&\n]+)/g;
        let m;
        while ((m = readVerb.exec(cmd)) !== null) {
          const argList = m[1].trim();
          for (const arg of argList.split(/\s+/)) {
            // Skip flags
            if (arg.startsWith('-')) continue;
            // Skip operators / empty
            if (!arg || arg === '&&' || arg === '||') continue;
            reads.push(normalizePath(arg));
          }
        }
        // Writes: redirects (>, >>) and tee
        const writeRedirect = /(?:^|\s)>>?\s+(\S+)/g;
        while ((m = writeRedirect.exec(cmd)) !== null) writes.push(normalizePath(m[1]));
        const writeTee = /(?:^|;|&&|\|\||\s)tee\s+(\S+)/g;
        while ((m = writeTee.exec(cmd)) !== null) writes.push(normalizePath(m[1]));
      }
    }

    // Assistant text
    if (evt.type === 'message' && evt.role === 'assistant' && typeof evt.content === 'string') {
      assistant.push(evt.content);
    }
  }

  return { reads, writes, assistant: assistant.join('\n') };
}

function normalizePath(p) {
  if (!p) return '';
  return p.replace(/^\/.*?\/robin-assistant\//, '').replace(/^\.\//, '');
}
