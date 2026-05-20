import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { buildContext } from '../../integrations/_runtime/context.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import {
  daemonHeartbeatingInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  userDataWritableInvariant,
} from '../invariants/builtins/index.ts';
import { runInvariants } from '../invariants/runner.ts';

const CHECK_INTERVAL_MS = 60_000; // every minute
const NOTIFY_COOLDOWN_MS = 60 * 60_000; // 1 hour: don't spam the same failure

interface HealthMonitorOptions {
  db: RobinDb;
  getLLM: () => LLMDispatcher | null | undefined;
  getLastTickAt: () => Date | null;
  /** Pass a getter (re-evaluated per tick) when the value can change without a daemon restart
   *  (e.g. driven from policies.yaml). Boolean is also accepted for tests / static configs. */
  enableNotifications?: boolean | (() => boolean);
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private log = createLogger({ module: 'health-monitor' });
  private lastNotifiedAt = new Map<string, number>(); // invariant name → ts

  constructor(private opts: HealthMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    // unref so this timer doesn't prevent process exit
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const userData = resolveUserDataDir();
    try {
      const reports = await runInvariants([
        userDataWritableInvariant(userData),
        dbReachableInvariant(this.opts.db),
        dbSchemaCurrentInvariant(this.opts.db),
        daemonHeartbeatingInvariant({
          lastTickAt: this.opts.getLastTickAt,
          maxIntervalMs: 5 * 60_000,
        }),
      ]);
      for (const r of reports) {
        if (r.ok) continue;
        if (r.severity !== 'critical') continue;
        const last = this.lastNotifiedAt.get(r.name) ?? 0;
        if (Date.now() - last < NOTIFY_COOLDOWN_MS) continue; // cooldown
        this.lastNotifiedAt.set(r.name, Date.now());
        this.log.error({ name: r.name, message: r.message }, 'invariant CRITICAL');
        const notifyOn =
          typeof this.opts.enableNotifications === 'function'
            ? this.opts.enableNotifications()
            : !!this.opts.enableNotifications;
        if (notifyOn) {
          try {
            const llm = this.opts.getLLM() ?? null;
            // Future: use ctx for richer integrations; for now, just call notifyMacOSAction
            buildContext('notify', this.opts.db, llm);
            const { notifyMacOSAction } = await import(
              '../../integrations/builtin/notify/index.ts'
            );
            await notifyMacOSAction({
              title: `Robin: ${r.name}`,
              message: r.message ?? 'critical invariant failed',
            });
          } catch (err) {
            this.log.warn({ err }, 'failed to send health notification');
          }
        }
      }
    } catch (err) {
      this.log.warn({ err }, 'health monitor tick threw');
    }
  }
}
