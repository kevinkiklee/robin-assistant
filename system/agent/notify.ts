import { notifyMacOSAction } from '../integrations/builtin/notify/index.ts';

/**
 * Why the run was halted on a billing/auth condition.
 *  - `pool-exhausted`: the prepaid Claude pool ran dry.
 *  - `auth-limit`: the active subscription/account hit a usage limit.
 * Both resolve the same way for the operator: switch accounts in the Claude TUI.
 */
export type ExhaustionReason = 'pool-exhausted' | 'auth-limit';

export interface NotifyResult {
  delivered: boolean;
  reason?: string;
}

export interface NotifyDeps {
  /** Operational notifier. Defaults to the macOS osascript path used by health alerts. */
  notify?: (params: { title: string; message: string }) => Promise<NotifyResult>;
}

const ACTION = 'Switch accounts in the Claude TUI to continue agentic runs.';

const MESSAGES: Record<ExhaustionReason, string> = {
  'pool-exhausted': `Claude pool credit exhausted. ${ACTION}`,
  'auth-limit': `Claude account usage limit reached. ${ACTION}`,
};

/**
 * Emit an operational notification when an agentic run can't proceed because the
 * pool/subscription is exhausted. Reuses the same osascript path as health-monitor
 * alerts (`notifyMacOSAction`) so there's one operational-notification surface.
 */
export async function notifyExhaustion(
  reason: ExhaustionReason,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const notify = deps.notify ?? notifyMacOSAction;
  return notify({
    title: 'Robin: agent paused',
    message: MESSAGES[reason],
  });
}
