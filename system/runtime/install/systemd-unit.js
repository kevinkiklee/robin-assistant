import { dirname } from 'node:path';

/**
 * Generate a systemd --user unit file for the Robin daemon.
 *
 * Uses an absolute path to the node binary (captured at install time via
 * process.execPath) because systemd's environment doesn't inherit nvm/asdf
 * shims, so `#!/usr/bin/env node` in `system/bin/robin` fails to resolve.
 *
 * @param {{ packageRoot: string, robinHome: string, nodePath?: string }} args
 * @returns {string} unit file content
 */
export function generateSystemdUnit({ packageRoot, robinHome, nodePath = process.execPath }) {
  const nodeBinDir = dirname(nodePath);
  return `[Unit]
Description=Robin MCP daemon
After=default.target

[Service]
Type=simple
Environment=ROBIN_HOME=${robinHome}
Environment=PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${nodePath} ${packageRoot}/system/bin/robin mcp start --foreground
Restart=on-failure
StandardOutput=append:${robinHome}/cache/logs/daemon.log
StandardError=append:${robinHome}/cache/logs/daemon.log

[Install]
WantedBy=default.target
`;
}
