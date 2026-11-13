// PreToolUse hook entry point for the blind secret window. Runs as its own
// process per tool call. With no window file it exits at once unless the call
// is `robin secret arm`; with a window file every failure denies (fail closed).
//
// Local modules load through dynamic import inside the try blocks: a static
// import that failed to load would crash the process with exit 1, which Claude
// Code treats as a non-blocking error and lets the call through.

import { statSync } from 'node:fs';

function denyOut(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

export async function main(): Promise<void> {
  let userData: string;
  let hasWindow: boolean;
  try {
    const { resolveUserDataDir } = await import('../../paths.ts');
    const { secretsPaths } = await import('../store.ts');
    userData = resolveUserDataDir();
    // statSync throws on EACCES and the like, so only a clean ENOENT reads as absent.
    hasWindow = statSync(secretsPaths(userData).window, { throwIfNoEntry: false }) !== undefined;
  } catch {
    denyOut('Secret guard could not check for an open secret window, so this call is blocked.');
    return;
  }

  try {
    const io = await import('./io.ts');
    const policy = await import('./guard-policy.ts');
    let input: Awaited<ReturnType<typeof io.readHookInput>> | undefined;
    try {
      input = await io.readHookInput();
    } catch {
      input = undefined;
    }

    // Ruling 1: no window and not an arm call → nothing to enforce.
    if (!hasWindow && (input === undefined || !policy.isArmCall(input))) return;
    if (input === undefined) throw new Error('unreadable hook input');

    const { readWindow, writeArmSession } = await import('../window.ts');
    const now = new Date();
    const decision = policy.decideGuard(input, readWindow(userData), now);
    if (decision.decision === 'deny') {
      denyOut(decision.reason);
      return;
    }
    if ('recordArm' in decision) {
      writeArmSession(userData, {
        sessionId: input.session_id,
        tabId: decision.recordArm.tabId,
        at: now.toISOString(),
      });
    }
  } catch {
    denyOut(
      hasWindow
        ? 'Secret guard failed while a secret window is open, so this call is blocked. If this persists, the operator can run `robin secret abort` in a terminal.'
        : 'Secret guard could not record the arming session, so `robin secret arm` is blocked.',
    );
  }
}

// Unconditional: this file only ever runs as the hook. A main-module check that
// misfired would skip enforcement, which is failing open.
await main();
