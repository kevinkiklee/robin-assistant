export function generateSystemdUnit({ nodeBin, serverPath }) {
  return `[Unit]
Description=Robin v2 MCP daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${serverPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}
