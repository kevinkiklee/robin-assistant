import { dirname } from 'node:path';

/**
 * Generate a systemd --user unit file for the standalone SurrealDB server.
 *
 * Pinned to an absolute `surreal` binary path so systemd's environment
 * (which doesn't inherit nvm/brew shims) can find it.
 *
 * @param {{
 *   surrealBin: string,
 *   bind?: string,
 *   user?: string,
 *   pass?: string,
 *   storage?: string,
 *   dbDir: string,
 *   logPath: string,
 * }} args
 * @returns {string} unit file content
 */
export function generateSurrealUnit({
  surrealBin,
  bind = '127.0.0.1:8000',
  user = 'root',
  pass = 'root',
  storage = 'surrealkv',
  dbDir,
  logPath,
}) {
  if (!surrealBin) throw new TypeError('generateSurrealUnit: surrealBin is required');
  if (!dbDir) throw new TypeError('generateSurrealUnit: dbDir is required');
  if (!logPath) throw new TypeError('generateSurrealUnit: logPath is required');
  const surrealBinDir = dirname(surrealBin);
  return `[Unit]
Description=Robin SurrealDB server
After=default.target

[Service]
Type=simple
Environment=PATH=${surrealBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${surrealBin} start --bind ${bind} --user ${user} --pass ${pass} --log info ${storage}://${dbDir}
Restart=on-failure
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}
