#!/usr/bin/env node
import { execSync } from 'node:child_process';

// Use a sentinel path inside user-data/ so the check works even when
// tracked files were force-staged inside the directory (which confuses
// `git check-ignore` on the directory itself).
try {
  execSync('git check-ignore -q user-data/.privacy-check', { stdio: 'pipe' });
} catch {
  console.error('FATAL: user-data/ is not gitignored. Refusing commit.');
  process.exit(1);
}

const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
  .split('\n').filter(Boolean)
  .filter(f => /^(user-data|artifacts|backup)\//.test(f));
if (staged.length) {
  console.error('FATAL: refusing to commit personal data. Staged files:');
  staged.forEach(f => console.error('  ' + f));
  process.exit(1);
}
