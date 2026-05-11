/**
 * Generate launchd plist XML for the Robin daemon.
 *
 * @param {{ packageRoot: string, robinHome: string }} args
 * @returns {string} plist XML
 */
export function generateLaunchdPlist({ packageRoot, robinHome }) {
  const logPath = `${robinHome}/cache/logs/daemon.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.robin-assistant.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${packageRoot}/bin/robin</string>
    <string>mcp</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${process.env.HOME ?? ''}</string>
    <key>ROBIN_HOME</key>
    <string>${robinHome}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}
