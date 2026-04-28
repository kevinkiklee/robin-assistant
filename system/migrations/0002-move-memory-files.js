export const id = '0002-move-memory-files';
export const description = 'Move memory files from user-data/ root into user-data/memory/';

export async function up({ workspaceDir, helpers }) {
  await helpers.renameFile('profile.md', 'memory/profile.md');
  await helpers.renameFile('knowledge.md', 'memory/knowledge.md');
  await helpers.renameFile('tasks.md', 'memory/tasks.md');
  await helpers.renameFile('decisions.md', 'memory/decisions.md');
  await helpers.renameFile('journal.md', 'memory/journal.md');
  await helpers.renameFile('inbox.md', 'memory/inbox.md');
  await helpers.renameFile('self-improvement.md', 'memory/self-improvement.md');
  await helpers.renameFile('index', 'memory/index');
}
