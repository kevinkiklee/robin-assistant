export const id = '0003-flatten-memory';
export const description = 'Flatten memory into topic folders, drop sidecars, consolidate trips into events';

export async function up({ workspaceDir, helpers, opts = {} }) {
  // Per-step implementation lands in subsequent tasks.
  throw new Error('not implemented');
}
