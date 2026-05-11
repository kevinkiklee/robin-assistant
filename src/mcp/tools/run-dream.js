export function createRunDreamTool({ db, host, embedder, dreamProcess }) {
  return {
    name: 'run_dream',
    description:
      'Manually trigger the dream pipeline (knowledge synthesis, pattern detection, correction clustering, profile inference, arc updates).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const summary = await dreamProcess(db, host, embedder);
      return { summary };
    },
  };
}
