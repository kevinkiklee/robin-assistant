import { dirname } from 'node:path';

// Minimal XML escape — paths with `&`, `<`, `>` would otherwise produce
// a broken plist that launchd refuses to load.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Generate launchd plist XML for the Robin daemon.
 *
 * Uses an absolute path to the node binary (captured at install time via
 * process.execPath) because launchd's environment doesn't include NVM's
 * shims, so `#!/usr/bin/env node` in `system/bin/robin` fails to resolve.
 * PATH is also seeded with the node binary's directory so child processes
 * spawned by the daemon (e.g. `claude`, `gemini`) can find their tooling.
 *
 * @param {{ packageRoot: string, robinHome: string, nodePath?: string }} args
 * @returns {string} plist XML
 */
export function generateLaunchdPlist({ packageRoot, robinHome, nodePath = process.execPath }) {
  const logPath = `${robinHome}/cache/logs/daemon.log`;
  const nodeBinDir = dirname(nodePath);
  const inheritedPath = process.env.PATH ?? '';
  const launchdPath = [
    nodeBinDir,
    inheritedPath,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ]
    .filter(Boolean)
    .join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.robin-assistant.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(packageRoot)}/system/bin/robin</string>
    <string>mcp</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${esc(process.env.HOME ?? '')}</string>
    <key>ROBIN_HOME</key>
    <string>${esc(robinHome)}</string>
    <key>PATH</key>
    <string>${esc(launchdPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(logPath)}</string>
</dict>
</plist>
`;
}
