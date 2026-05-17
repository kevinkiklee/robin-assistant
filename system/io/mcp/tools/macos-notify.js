import { spawn } from 'node:child_process';

export function createMacosNotifyTool({ runCommand = defaultRunCommand, platform = process.platform } = {}) {
  return {
    name: 'macos_notify',
    description:
      'Send a macOS desktop notification via Notification Center. Prefers terminal-notifier (signed bundle, supports click callbacks); falls back to osascript. Returns { delivered, backend }. No-op on non-macOS hosts.',
    inputSchema: {
      type: 'object',
      properties: {
        title:     { type: 'string', minLength: 1, maxLength: 256 },
        body:      { type: 'string', maxLength: 1024 },
        subtitle:  { type: 'string', maxLength: 256 },
        sound:     { type: 'string', maxLength: 32 },
        click_url: { type: 'string', maxLength: 2048 },
      },
      required: ['title'],
    },
    handler: async (args) => {
      if (platform !== 'darwin') {
        return { delivered: false, backend: 'noop', reason: 'non-macos' };
      }
      if (await hasTerminalNotifier(runCommand)) {
        const argv = ['-title', args.title];
        if (args.subtitle) argv.push('-subtitle', args.subtitle);
        if (args.body) argv.push('-message', args.body);
        if (args.sound) argv.push('-sound', args.sound);
        if (args.click_url) argv.push('-open', args.click_url);
        try {
          await runCommand('terminal-notifier', argv, { timeoutMs: 5000 });
          return { delivered: true, backend: 'terminal-notifier' };
        } catch {
          // fall through to osascript
        }
      }
      try {
        await runCommand('osascript', ['-e', buildOsascript(args)], { timeoutMs: 5000 });
        return {
          delivered: true,
          backend: 'osascript',
          limitations: 'no click callback; throttled by Notification Center; bundle ID shows as "Script Editor"',
        };
      } catch (e) {
        return { delivered: false, backend: null, error: String(e?.message ?? e) };
      }
    },
  };
}

async function hasTerminalNotifier(runCommand) {
  try {
    await runCommand('command', ['-v', 'terminal-notifier'], { timeoutMs: 1000, shell: true });
    return true;
  } catch {
    return false;
  }
}

function buildOsascript(args) {
  const escape = (s) => String(s).replace(/[\\"]/g, (c) => '\\' + c);
  const title = escape(args.title);
  const body = escape(args.body ?? '');
  const subtitle = args.subtitle ? ` subtitle "${escape(args.subtitle)}"` : '';
  const sound = args.sound ? ` sound name "${escape(args.sound)}"` : '';
  return `display notification "${body}" with title "${title}"${subtitle}${sound}`;
}

function defaultRunCommand(cmd, args, { timeoutMs = 5000, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell });
    let stdout = '';
    let stderr = '';
    let timed = false;
    const timer = setTimeout(() => {
      timed = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); if (!timed) reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (timed) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}
