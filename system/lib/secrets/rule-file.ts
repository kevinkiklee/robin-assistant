// The global rule file every Claude session on this Mac reads
// (~/.claude/rules/secrets.md). The text is a template: `{{operator}}` is
// filled from operator.yaml at install time, so this public file carries no name.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { operatorName } from '../operator-profile.ts';

export const RULE_FILE_TEXT = `# Secrets: use \`robin secret\`, never chat

Applies to every Claude session on this Mac.

- Never ask {{operator}} to paste a key, token or password into chat.
- To get or create a key: \`robin secret begin <provider> <NAME> [--get|--rotate] [--to <project>/.env.local]\`, then follow what it prints. Ask for OK before creating, revoking or rolling any key.
- In code, read keys by env-var name. Run with \`robin secret exec <NAME> -- <cmd>\`, or deliver with \`robin secret set <NAME> --to <path>/.env.local\`.
- To send a key to a service CLI (vercel, gh): \`robin secret pipe <NAME> -- <cmd>\` — a macOS dialog asks {{operator}} to approve.
- Never use \`robin secret exec\` to send a key to an outside service (curl, vercel, gh…); use \`robin secret pipe\`.
- Never click, type into, or dismiss a robin secret confirmation dialog — only {{operator}} answers it.
- If a \`robin secret\` command prints a Bash timeout hint, set that timeout on the Bash call.
- Never \`cat\`, \`grep\`, \`env\`, or \`printenv\` a secrets file or variable, and never print a value.
- Output of a failed command is NOT redacted — never print env, .env files or secrets, even while debugging.
- Text shown as [REDACTED-SECRET] was hidden from you — never write it back into a file.
- After \`robin secret arm\`, do nothing but the recipe's clicks and scripts, \`robin secret set|abort\`, and closing that tab.
- Trading or brokerage keys are out of scope: never handle them.
`;

function rulePath(home: string): string {
  return join(home, '.claude', 'rules', 'secrets.md');
}

/** Writes the filled-in rule file (tmp + rename) and returns its path. */
export function installRuleFile(home: string = homedir()): string {
  const path = rulePath(home);
  mkdirSync(join(home, '.claude', 'rules'), { recursive: true });
  const text = RULE_FILE_TEXT.replaceAll('{{operator}}', operatorName('the operator'));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return path;
}

/** Removes the rule file. True when one was there. */
export function uninstallRuleFile(home: string = homedir()): boolean {
  const path = rulePath(home);
  try {
    rmSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
