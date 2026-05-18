// Outbound iMessage send via osascript.
//
// Apple throttles scripted sends at roughly 1/sec sustained; we self-rate-limit
// (200ms between sends) to keep below that. Larger attachments are handled
// the same way — Messages.app takes longer to receive them but the script
// returns once it's queued.
//
// AppleScript send target:
//   - DM (buddy):  use the handle/email directly via `participant 1`
//   - Group chat:  Apple supports `set targetChat to chat id <guid>` then `send "text" to targetChat`
//
// On non-darwin hosts: refuses with `{ ok: false, reason: 'non-macos' }`.

import { spawn } from 'node:child_process';

const MIN_SEND_INTERVAL_MS = 200;
let lastSendAt = 0;

export async function sendDm({
  handle,
  message,
  runCommand = defaultRunCommand,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') return { ok: false, reason: 'non-macos' };
  if (!handle) throw new Error('sendDm: handle required');
  if (!message || typeof message !== 'string') throw new Error('sendDm: message required (string)');
  await waitForRateLimit();
  const script = `
    tell application "Messages"
      set targetService to first service whose service type = iMessage
      set targetBuddy to buddy "${escapeApplescript(handle)}" of targetService
      send "${escapeApplescript(message)}" to targetBuddy
    end tell`;
  try {
    await runCommand('osascript', ['-e', script], { timeoutMs: 15_000 });
    return { ok: true, target: { kind: 'dm', handle } };
  } catch (e) {
    return { ok: false, reason: 'osascript_failed', error: String(e?.message ?? e) };
  }
}

export async function sendGroup({
  chatGuid,
  message,
  runCommand = defaultRunCommand,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') return { ok: false, reason: 'non-macos' };
  if (!chatGuid) throw new Error('sendGroup: chatGuid required');
  if (!message || typeof message !== 'string')
    throw new Error('sendGroup: message required (string)');
  await waitForRateLimit();
  const script = `
    tell application "Messages"
      set targetChat to chat id "${escapeApplescript(chatGuid)}"
      send "${escapeApplescript(message)}" to targetChat
    end tell`;
  try {
    await runCommand('osascript', ['-e', script], { timeoutMs: 15_000 });
    return { ok: true, target: { kind: 'group', chat_guid: chatGuid } };
  } catch (e) {
    return { ok: false, reason: 'osascript_failed', error: String(e?.message ?? e) };
  }
}

async function waitForRateLimit() {
  const elapsed = Date.now() - lastSendAt;
  if (elapsed < MIN_SEND_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_SEND_INTERVAL_MS - elapsed));
  }
  lastSendAt = Date.now();
}

export function escapeApplescript(s) {
  return String(s).replace(/[\\"]/g, (c) => '\\' + c);
}

function defaultRunCommand(cmd, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timed = false;
    const timer = setTimeout(() => {
      timed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c) => {
      stdout += c;
    });
    child.stderr?.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (!timed) reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (timed) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}
