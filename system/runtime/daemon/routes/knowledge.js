// /internal/knowledge/{ingest,lint,audit} forward to the corresponding MCP
// tool by name. The forwarding is a known duplication smell — see the spec.
// Leaving as-is until tool factories are reshaped in a separate cleanup.

function forwardTool(toolName) {
  return async ({ body, tools }) => {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        _status: 500,
        _body: { ok: false, reason: `${toolName}_tool_not_registered` },
      };
    }
    return await tool.handler(body);
  };
}

export const knowledgeRoutes = [
  {
    method: 'POST',
    path: '/internal/knowledge/ingest',
    handler: forwardTool('ingest'),
  },
  {
    method: 'POST',
    path: '/internal/knowledge/lint',
    handler: forwardTool('lint'),
  },
  {
    method: 'POST',
    path: '/internal/knowledge/audit',
    handler: forwardTool('audit'),
  },
];
