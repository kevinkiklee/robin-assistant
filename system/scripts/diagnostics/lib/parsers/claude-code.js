// Claude Code transcript parser.
//
// Claude Code loads CLAUDE.md/AGENTS.md and other Tier 1 files into the
// SYSTEM PROMPT (cache_creation_input_tokens) at session start, not as
// Read tool calls. So an absence of `Read("AGENTS.md")` in the transcript
// doesn't mean the file wasn't loaded — it means it was loaded by the
// framework, not requested by the agent. The parser exposes a signal
// `system_context_bytes` so validators can downgrade absence-checks to
// SOFT NOTE for Claude Code.
//
// Input: raw transcript text. Output: { reads, writes, assistant, system_context_bytes }.

export function parseClaudeCode(text) {
  const reads = [];
  const writes = [];
  const assistant = [];
  let systemContextBytes = 0;

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

    // Tool calls (top-level shape: {name, input, ...})
    const topLevelToolName = evt.name ?? evt.tool ?? evt.tool_name;
    const topLevelPath = evt.input?.file_path ?? evt.path ?? evt.arguments?.file_path;
    if (topLevelToolName === 'Read' && topLevelPath) reads.push(normalizePath(topLevelPath));
    else if (
      (topLevelToolName === 'Write' || topLevelToolName === 'Edit' || topLevelToolName === 'NotebookEdit') &&
      topLevelPath
    )
      writes.push(normalizePath(topLevelPath));

    // Claude Code shape: type=assistant, message.content=[{type:tool_use, name, input}, {type:text,text}]
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') assistant.push(block.text);
        if (block.type === 'tool_use') {
          const tn = block.name;
          const tp = block.input?.file_path;
          if (tn === 'Read' && tp) reads.push(normalizePath(tp));
          else if ((tn === 'Write' || tn === 'Edit' || tn === 'NotebookEdit') && tp)
            writes.push(normalizePath(tp));
        }
      }
    }
    if (evt.role === 'assistant' && typeof evt.content === 'string') assistant.push(evt.content);
    if (evt.type === 'text' && typeof evt.text === 'string') assistant.push(evt.text);

    // System context: cache_creation_input_tokens is a proxy for "AGENTS.md
    // and friends were loaded into the prompt, even without explicit Reads."
    const usage = evt.message?.usage ?? evt.usage;
    if (usage?.cache_creation_input_tokens) {
      systemContextBytes += usage.cache_creation_input_tokens * 4; // approx tokens→bytes
    }
  }

  // Fallback: scan free-text transcripts for Read("...") / Edit("...") patterns.
  if (reads.length === 0 && writes.length === 0) {
    const readRe = /Read\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const writeRe = /(?:Write|Edit|NotebookEdit)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = readRe.exec(text)) !== null) reads.push(normalizePath(m[1]));
    while ((m = writeRe.exec(text)) !== null) writes.push(normalizePath(m[1]));
  }

  return { reads, writes, assistant: assistant.join('\n'), system_context_bytes: systemContextBytes };
}

function normalizePath(p) {
  // Strip leading absolute prefix down to repo-relative if present.
  // Hosts may emit absolute paths; we compare against repo-relative.
  return p.replace(/^\/.*?\/robin-assistant\//, '').replace(/^\.\//, '');
}
