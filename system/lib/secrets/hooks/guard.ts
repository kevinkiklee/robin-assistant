// PreToolUse hook entry point for the blind secret window. Runs as its own
// process per tool call. With no window file it exits at once unless the call
// is `robin secret arm` or an edit carrying the redaction marker; with a window
// file every failure denies (fail closed).
//
// Local modules load through dynamic import inside the try blocks: a static
// import that failed to load would crash the process with exit 1, which Claude
// Code treats as a non-blocking error and lets the call through. For the same
// reason this file writes its deny JSON itself instead of using io.ts `emit`.

import { readFileSync, statSync } from 'node:fs';

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

/** The current arm-session record, or undefined when absent or unparseable (both may be overwritten). */
function readExistingArm(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function main(): Promise<void> {
  let userData: string;
  let paths: { window: string; armSession: string };
  let hasWindow: boolean;
  try {
    const { resolveUserDataDir } = await import('../../paths.ts');
    const { secretsPaths } = await import('../store.ts');
    userData = resolveUserDataDir();
    paths = secretsPaths(userData);
    // statSync throws on EACCES and the like, so only a clean ENOENT reads as absent.
    hasWindow = statSync(paths.window, { throwIfNoEntry: false }) !== undefined;
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

    // Ruling 1: no window, not an arm call and no marker edit → nothing to enforce.
    if (
      !hasWindow &&
      (input === undefined || (!policy.isArmCall(input) && !policy.isMarkerEdit(input)))
    ) {
      return;
    }
    if (input === undefined) throw new Error('unreadable hook input');

    const { readWindow, writeArmSession } = await import('../window.ts');
    const now = new Date();
    const decision = policy.decideGuard(input, readWindow(userData), now);
    if (decision.decision === 'deny') {
      denyOut(decision.reason);
      return;
    }
    if ('recordArm' in decision) {
      const record = {
        sessionId: input.session_id,
        tabId: decision.recordArm.tabId,
        at: now.toISOString(),
      };
      // Exclusive create first, so two sessions arming at once can't both
      // write blind; only an existing record gets the fresh/owner check.
      try {
        writeArmSession(userData, record, { exclusive: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (policy.armBlocked(readExistingArm(paths.armSession), input.session_id, now)) {
          denyOut(policy.ARM_BUSY_REASON);
          return;
        }
        writeArmSession(userData, record);
      }
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
