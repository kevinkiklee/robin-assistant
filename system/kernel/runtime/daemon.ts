import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import type { WatcherHandle } from '../../integrations/_runtime/watch.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { dbFilePath, pidFilePath, resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';
import { writeTelemetry } from '../../lib/telemetry/write.ts';
import { VERSION } from '../../lib/version.ts';
import { type HttpHandle, startHttpServer } from '../../surfaces/http/server.ts';
import { loadModels, loadPolicies } from '../config/load.ts';
import { recoverDeadWorkerLeases, recoverExpiredLeases } from '../scheduler/claim.ts';
import { type JobHandler, Scheduler } from '../scheduler/runner.ts';
import { isProcessAlive, readPidfile, removePidfile, writePidfile } from './pidfile.ts';

const TICK_INTERVAL_MS = 1000;
const LEASE_MS = 5 * 60 * 1000; // 5 min
// Bug B fix — periodic in-process sweep so abandoned leases don't pile up between
// boots. Boot-time `recoverExpiredLeases` only fires on cold start; without this
// interval, a stuck handler that the scheduler eventually times-out would leave its
// row in `leased` indefinitely until the next daemon restart.
const LEASE_REAPER_INTERVAL_MS = 60_000;

export interface DaemonRunOptions {
  foreground?: boolean;
  /** Override the HTTP hook/health port. Falls back to ROBIN_DAEMON_HTTP_PORT, then 41273. Use 0 to bind an OS-assigned port (useful in tests). */
  httpPort?: number;
}

export class Daemon {
  private db?: RobinDb;
  private scheduler?: Scheduler;
  private log = createLogger({ module: 'daemon' });
  private running = false;
  private startedAt = 0;
  private lastTickAt: Date | null = null;
  private handlers = new Map<string, JobHandler>();
  private llm?: LLMDispatcher;
  private http?: HttpHandle;
  private integrationWatcher?: WatcherHandle;
  private integrationCleanup?: () => Promise<void>;
  private healthMonitor?: import('./health-monitor.ts').HealthMonitor;
  private powerMonitor?: import('../../lib/power-auto/monitor.ts').PowerAutoMonitor;
  private leaseReaperTimer: NodeJS.Timeout | null = null;

  registerHandler(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  getLLM(): LLMDispatcher | undefined {
    return this.llm;
  }

  async start(opts: DaemonRunOptions = {}): Promise<void> {
    if (this.running) return;
    const userData = resolveUserDataDir();
    const pidPath = pidFilePath(userData);

    // Populate process.env from user-data/config/secrets/.env before any
    // integration or LLM provider tries to read process.env. Shell-provided
    // values win; missing file is fine (launchd/1Password setups inject env
    // a different way).
    const envResult = loadEnvFile(userData);
    if (envResult.loaded > 0) {
      this.log.info(
        { loaded: envResult.loaded, overwritten: envResult.overwritten, path: envResult.path },
        'secrets/.env loaded',
      );
    }

    // Check for an existing live daemon
    const existing = readPidfile(pidPath);
    if (existing && isProcessAlive(existing)) {
      throw new Error(`Daemon already running with pid ${existing}`);
    }

    writePidfile(pidPath);
    this.log = createLogger({
      module: 'daemon',
      file: join(userData, 'observability', 'logs', 'daemon.log'),
    });

    const dbPath = dbFilePath(userData);
    this.db = openDb(dbPath);
    applyMigrations(this.db, allMigrations);

    // Apply policies
    const policies = loadPolicies(userData);
    this.log.info({ event: 'daemon.start', state: policies.power.state }, 'daemon starting');

    // LLM dispatcher — built from models.yaml, lenient (warn + skip on missing secrets)
    const models = loadModels(userData);
    try {
      this.llm = buildDispatcherFromConfig(models, {
        lenient: true,
        onWarn: (msg) => this.log.warn({ msg }, 'llm provider unavailable'),
      });
    } catch (err) {
      this.log.error({ err }, 'failed to build LLM dispatcher');
    }

    // Recovery sweep — two passes:
    //   1. `recoverExpiredLeases` cleans up rows whose lease has already expired
    //      (the "we crashed mid-handler" path).
    //   2. `recoverDeadWorkerLeases` cleans up rows still leased to a predecessor
    //      worker after a controlled restart (`launchctl kickstart -k`). Without
    //      this, the new daemon idles up to LEASE_MS waiting for the predecessor's
    //      lease to expire naturally even though that process is already gone.
    const workerId = `daemon-${process.pid}`;
    const recoveredExpired = recoverExpiredLeases(this.db);
    const recoveredDead = recoverDeadWorkerLeases(this.db, workerId);
    const recovered = recoveredExpired + recoveredDead;
    if (recovered > 0) {
      this.log.warn(
        { count: recovered, expired: recoveredExpired, dead: recoveredDead },
        'recovered expired/dead leases',
      );
    }

    writeTelemetry(this.db, 'daemon.start', { version: VERSION }, { source: 'daemon' });

    this.scheduler = new Scheduler({
      db: this.db,
      handlers: this.handlers,
      workerId,
      leaseMs: LEASE_MS,
      // Pause the whole scheduler when power isn't active OR the network is
      // offline. Post-cloud-migration (2026-05-24) all cognition + integrations
      // are outbound, so `network: offline` must cleanly halt scheduled work —
      // not let cloud cognition fire and error/circuit-break every tick.
      isPaused: () => {
        const p = loadPolicies(userData);
        return p.power.state !== 'active' || p.network.mode === 'offline';
      },
      onError: (err, job) => this.log.error({ err, job: job.name }, 'job handler error'),
    });

    // Bug B fix — periodic in-process lease reaper. The boot-time sweep above
    // catches leases left behind by a crashed daemon, but says nothing about
    // leases that expire while the same daemon is still alive (e.g. a handler
    // that hangs indefinitely on an external call). setInterval runs on its own
    // microtask cycle, so it fires even while `runLoop` is awaiting a wedged
    // handler — keeping the jobs table accurate and enabling lease handoff if
    // a second worker is ever added.
    const db = this.db;
    this.leaseReaperTimer = setInterval(() => {
      try {
        const reaped = recoverExpiredLeases(db);
        if (reaped > 0) this.log.warn({ count: reaped }, 'reaped expired leases (in-process)');
      } catch (err) {
        this.log.warn({ err }, 'lease reaper threw');
      }
    }, LEASE_REAPER_INTERVAL_MS);
    if (typeof this.leaseReaperTimer.unref === 'function') this.leaseReaperTimer.unref();

    // HTTP endpoint for hooks + health probe
    try {
      // Capture db in a local binding so the closure doesn't depend on
      // `this.db` (which TS narrows as possibly-undefined at closure time).
      const db = this.db;
      const envPort = process.env.ROBIN_DAEMON_HTTP_PORT
        ? Number.parseInt(process.env.ROBIN_DAEMON_HTTP_PORT, 10)
        : undefined;
      const httpPort =
        opts.httpPort ?? (envPort != null && envPort >= 0 && envPort <= 65535 ? envPort : 41273);
      this.http = await startHttpServer({
        db,
        llm: this.llm ?? null,
        userData,
        port: httpPort,
        isHealthy: () => this.running,
        onHook: async (kind, payload) => {
          writeTelemetry(
            db,
            'invariant.check',
            { name: `hook.${kind}`, ok: true },
            { source: 'http' },
          );
          this.log.info({ kind, payload }, 'hook received');

          // session_end is the wire for Claude Code → Robin capture. The hook posts the
          // JSON Claude Code sends on stdin (session_id + transcript_path); we read the
          // .jsonl, project it into SessionTurn[], and run it through captureSession's
          // skip-rules + dedup. Without this branch the hook was silently no-op'ing the
          // entire session-capture pipeline — every Claude Code session was being logged
          // as "hook received" and then forgotten.
          if (kind === 'session_end') {
            try {
              const p = payload as {
                session_id?: string;
                transcript_path?: string;
                cwd?: string;
              };
              if (p.session_id && p.transcript_path) {
                const { captureSession, transcriptFileToCapture } = await import(
                  '../../brain/cognition/capture.ts'
                );
                const cap = transcriptFileToCapture(p.session_id, p.transcript_path, p.cwd);
                const r = await captureSession(db, this.llm ?? null, cap);
                this.log.info(
                  {
                    sessionId: p.session_id,
                    cwd: p.cwd,
                    captured: r.captured,
                    skipReason: r.skipReason,
                  },
                  'session_end processed',
                );
              }
            } catch (err) {
              this.log.warn({ err }, 'session_end capture failed');
            }
          }
        },
      });
      this.log.info({ port: this.http.port }, 'http server listening');
    } catch (err) {
      this.log.warn({ err }, 'http server start failed; continuing without hooks');
    }

    // Health monitor for invariant checks. Notifications gate is re-read each tick
    // via the closure, so flipping policies.yaml takes effect without a daemon restart.
    try {
      const { HealthMonitor } = await import('./health-monitor.ts');
      this.healthMonitor = new HealthMonitor({
        db: this.db,
        getLLM: () => this.llm,
        getLastTickAt: () => this.lastTickAt,
        enableNotifications: () => loadPolicies(userData).notifications.health,
        getStartedAt: () => this.startedAt,
        // Bug A fix — when heartbeating fails, the scheduler is stuck awaiting a
        // handler call. No graceful path can recover (the runLoop's `await
        // tickOnce()` won't return). Exit hard so launchd respawns; the boot-time
        // lease sweep + cron re-arm at the next boot will resume work.
        onHeartbeatCritical: () => {
          this.log.error('heartbeat-recovery: exit(1) for launchd respawn');
          // Force-exit on next tick so the error log line flushes first.
          setImmediate(() => process.exit(1));
        },
      });
      this.healthMonitor.start();
    } catch (err) {
      this.log.warn({ err }, 'health monitor failed to start');
    }

    // Power auto-monitor for battery threshold
    try {
      const { PowerAutoMonitor } = await import('../../lib/power-auto/monitor.ts');
      this.powerMonitor = new PowerAutoMonitor();
      this.powerMonitor.start();
    } catch (err) {
      this.log.warn({ err }, 'power auto-monitor failed to start');
    }

    // Register cognition + integration job handlers + seed cron schedules
    try {
      const { registerCognitionJobs } = await import('../../brain/cognition/jobs.ts');
      registerCognitionJobs(this, this.db, () => this.llm);

      // Boot-drain disabled 2026-05-21 Turn 4. The original boot-drain ran
      // `runBiographer(25)` in a parallel async task, intending to chew through
      // backlog faster than the */15 cron. In practice it duplicated the cron's work
      // and serialized through single-flight Ollama, so the parallel task starved the
      // scheduler runLoop's tickOnce → `lastTickAt` stopped updating → Bug A's
      // sustained-CRITICAL gate fired and restarted the daemon in a loop. Now the
      // cron handler (batch=1, ~11 min per session) is the only biographer driver.
      // Backlog drain is steady at ~4/hr; not fast, but recovery-loop-free.

      const { registerIntegrations } = await import(
        '../../integrations/_runtime/scheduler-glue.ts'
      );
      const r = await registerIntegrations(this, this.db, () => this.llm);
      this.integrationCleanup = r.cleanup;
      this.log.info(
        { registered: r.registered, scheduled: r.scheduled, initialized: r.initialized },
        'integrations wired into scheduler',
      );

      // User-extension jobs (daily-brief, etc.)
      try {
        const { registerJobs } = await import('../../jobs/_runtime/scheduler-glue.ts');
        const jr = await registerJobs(this, this.db, () => this.llm);
        this.log.info(
          { registered: jr.registered, scheduled: jr.scheduled },
          'jobs wired into scheduler',
        );
      } catch (err) {
        this.log.warn({ err }, 'jobs registration failed');
      }

      // Hot-reload watcher (integrations + jobs)
      try {
        const { watchIntegrations } = await import('../../integrations/_runtime/watch.ts');
        const sysIntegrationsPath = join(process.cwd(), 'system/integrations/builtin');
        const userIntegrationsPath = join(userData, 'extensions/integrations');
        const userJobsPath = join(userData, 'extensions/jobs');
        this.integrationWatcher = watchIntegrations(this, this.db, () => this.llm, [
          sysIntegrationsPath,
          userIntegrationsPath,
          userJobsPath,
        ]);
      } catch (err) {
        this.log.warn({ err }, 'integration watcher failed to start');
      }
    } catch (err) {
      this.log.error({ err }, 'failed to wire cognition/integrations into scheduler');
    }

    this.running = true;
    this.startedAt = Date.now();
    this.setupSignals();

    if (opts.foreground) {
      this.log.info('running in foreground; Ctrl-C to stop');
    }
    await this.runLoop();
  }

  private setupSignals(): void {
    const shutdown = async (sig: NodeJS.Signals) => {
      this.log.info({ signal: sig }, 'shutdown signal received');
      try {
        await this.stop(`signal:${sig}`);
      } catch (err) {
        this.log.error({ err, signal: sig }, 'shutdown failed');
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.scheduler?.tickOnce();
        this.lastTickAt = new Date();
      } catch (err) {
        this.log.error({ err }, 'tick failed');
      }
      await sleep(TICK_INTERVAL_MS);
    }
  }

  async stop(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const uptime = Date.now() - this.startedAt;
    if (this.http) {
      await this.http.close();
    }
    if (this.integrationWatcher) {
      await this.integrationWatcher.close();
    }
    if (this.integrationCleanup) {
      await this.integrationCleanup();
    }
    if (this.healthMonitor) this.healthMonitor.stop();
    if (this.powerMonitor) this.powerMonitor.stop();
    if (this.leaseReaperTimer) {
      clearInterval(this.leaseReaperTimer);
      this.leaseReaperTimer = null;
    }
    if (this.db) {
      writeTelemetry(
        this.db,
        'daemon.shutdown',
        { reason, uptime_ms: uptime },
        { source: 'daemon' },
      );
      closeDb(this.db);
    }
    const userData = resolveUserDataDir();
    removePidfile(pidFilePath(userData));
    this.log.info({ reason, uptime_ms: uptime }, 'daemon stopped');
  }

  getLastTickAt(): Date | null {
    return this.lastTickAt;
  }

  getHttpPort(): number | undefined {
    return this.http?.port;
  }
}
