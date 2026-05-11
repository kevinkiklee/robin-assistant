/**
 * Generate a systemd --user unit file for the Robin daemon.
 *
 * @param {{ packageRoot: string, robinHome: string }} args
 * @returns {string} unit file content
 */
export function generateSystemdUnit({ packageRoot, robinHome }) {
  return `[Unit]
Description=Robin MCP daemon
After=default.target

[Service]
Type=simple
Environment=ROBIN_HOME=${robinHome}
ExecStart=${packageRoot}/bin/robin mcp start --foreground
Restart=on-failure
StandardOutput=append:${robinHome}/cache/logs/daemon.log
StandardError=append:${robinHome}/cache/logs/daemon.log

[Install]
WantedBy=default.target
`;
}
