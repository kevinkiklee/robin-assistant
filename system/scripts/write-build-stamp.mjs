// system/scripts/write-build-stamp.mjs — stamp dist/ with the git SHA (+ a
// content hash of the deep dependency tree) so long-lived processes (daemon,
// MCP servers) can detect they're serving a stale build (reliability spec:
// mcp.dist-current), and the MCP hot-reload can refuse an unsafe swap when
// modules it can't refresh have changed too. Written LAST in `build`.
//
// Thin CLI — the exclusion boundary and hash computation live in
// deep-hash.mjs, where they're independently testable.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { computeDeepHash, SELF_IMPORTED_FILES } from './deep-hash.mjs';

let sha = 'unknown';
try {
  sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout (packaged install) — stamp still written */
}

const deepHash = computeDeepHash('dist', SELF_IMPORTED_FILES);
const stampLines = [sha, new Date().toISOString()];
if (deepHash) stampLines.push(deepHash);
writeFileSync('dist/.build-stamp', `${stampLines.join('\n')}\n`);
console.log(
  `Stamped dist/.build-stamp (${sha}${deepHash ? `, deep=${deepHash.slice(0, 12)}` : ''})`,
);
