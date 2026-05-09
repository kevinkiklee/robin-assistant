export function generateLaunchdPlist({ label, nodeBin, serverPath, home }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${serverPath}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${home}/.robin/logs/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/.robin/logs/daemon.log</string>
</dict>
</plist>
`;
}
