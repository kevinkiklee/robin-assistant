import { dirname } from 'node:path';

// Minimal XML escape — paths with `&`, `<`, `>` would otherwise produce
// a broken plist that launchd refuses to load.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SurrealKV defaults its block cache to ~50% of system RAM (≈32 GB on a 64 GB
// Mac) regardless of dataset size. Robin's DB is ~1–2 GB; 512 MB comfortably
// caches the entire working set while saving 30+ GB of virtual address space
// and the page-table/macOS-memory-manager overhead that comes with it. Read
// via the `SURREAL_SURREALKV_BLOCK_CACHE_CAPACITY` env var, value in bytes.
const SURREALKV_BLOCK_CACHE_CAPACITY_DEFAULT = 512 * 1024 * 1024;

/**
 * Generate launchd plist XML for the standalone SurrealDB server.
 *
 * Pinned to an absolute `surreal` binary path (captured at install time
 * via `which surreal`) so launchd's stripped PATH doesn't break the spawn.
 *
 * @param {{
 *   surrealBin: string,
 *   bind?: string,
 *   user?: string,
 *   pass?: string,
 *   storage?: string,
 *   dbDir: string,
 *   logPath: string,
 *   blockCacheCapacity?: number,
 * }} args
 * @returns {string} plist XML
 */
export function generateSurrealPlist({
  surrealBin,
  bind = '127.0.0.1:8000',
  user = 'root',
  pass = 'root',
  storage = 'surrealkv',
  dbDir,
  logPath,
  blockCacheCapacity = SURREALKV_BLOCK_CACHE_CAPACITY_DEFAULT,
}) {
  if (!surrealBin) throw new TypeError('generateSurrealPlist: surrealBin is required');
  if (!dbDir) throw new TypeError('generateSurrealPlist: dbDir is required');
  if (!logPath) throw new TypeError('generateSurrealPlist: logPath is required');
  const surrealBinDir = dirname(surrealBin);
  const inheritedPath = process.env.PATH ?? '';
  const launchdPath = [
    surrealBinDir,
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
  <string>io.robin-assistant.surreal</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(surrealBin)}</string>
    <string>start</string>
    <string>--bind</string>
    <string>${esc(bind)}</string>
    <string>--user</string>
    <string>${esc(user)}</string>
    <string>--pass</string>
    <string>${esc(pass)}</string>
    <string>--log</string>
    <string>info</string>
    <string>${esc(storage)}://${esc(dbDir)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(launchdPath)}</string>
    <key>SURREAL_SURREALKV_BLOCK_CACHE_CAPACITY</key>
    <string>${esc(blockCacheCapacity)}</string>
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
