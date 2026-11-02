import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

const execFileP = promisify(execFile);

async function notifyMacOS(title: string, message: string): Promise<void> {
  if (platform() !== 'darwin') return;
  const safeTitle = title.replace(/"/g, '\\"');
  const safeMsg = message.replace(/"/g, '\\"');
  await execFileP('osascript', [
    '-e',
    `display notification "${safeMsg}" with title "${safeTitle}"`,
  ]);
}

export const integration: Integration = {
  async health(_ctx: IntegrationContext) {
    return {
      ok: true,
      message: platform() === 'darwin' ? 'macOS osascript available' : 'limited (non-darwin)',
    };
  },
};

export async function notifyMacOSAction(params: {
  title: string;
  message: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  try {
    await notifyMacOS(params.title, params.message);
    return { delivered: true };
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
