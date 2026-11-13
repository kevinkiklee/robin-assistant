// `robin secret …` — the agent-facing key manager. Everything printed here is
// read by an AI agent, so no path prints a key value: fingerprints only.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ClipboardIO,
  hashText,
  macClipboard,
  takeFreshCopy,
  waitForFreshCopy,
} from '../../lib/secrets/clipboard.ts';
import {
  addDelivery,
  checkIgnored,
  type DeliveryTarget,
  deliverFileTarget,
  deliverToEnvLocal,
  pruneMissing,
  readDeliveries,
  redeliverFileTargets,
  runExec,
  runPipe,
} from '../../lib/secrets/deliveries.ts';
import { readEnvFile } from '../../lib/secrets/env-file.ts';
import { googleIntegrationFor } from '../../lib/secrets/recipes/google.ts';
import { getRecipe, type Recipe, scriptHashes } from '../../lib/secrets/recipes/index.ts';
import {
  appendLog,
  assertNameAllowed,
  defaultShape,
  findShadowing,
  fingerprint,
  getMaster,
  importRobinEnv,
  secretsPaths,
  setMaster,
} from '../../lib/secrets/store.ts';
import {
  clearOp,
  closeWindow,
  isExpired,
  readOp,
  readWindow,
  type SecretOp,
  type SecretWindow,
  takeArmSession,
  updateWindow,
  writeOp,
  writeWindow,
} from '../../lib/secrets/window.ts';

type GitFn = NonNullable<Parameters<typeof checkIgnored>[1]>;

export interface SecretDeps {
  userData: string;
  clipboard: ClipboardIO;
  env: NodeJS.ProcessEnv;
  /** Undefined → `launchctl getenv` (store.ts default). */
  launchctlGetenv?: (name: string) => string | undefined;
  /** Undefined → real git (deliveries.ts default). */
  git?: GitFn;
  spawn: typeof spawnSync;
  now: () => Date;
  out: (s: string) => void;
  restartDaemon: (userData: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  readStdin: () => Promise<string>;
}

const WINDOW_MS = 120_000;
const WAIT_MS = 120_000;
const POLL_MS = 1_000;
const OP_STALE_MS = 60 * 60_000;
const ALREADY_OPEN = 'A secret window is already open; run `robin secret abort` first.';

const USAGE = `usage: robin secret <command>
  begin <provider> <NAME> [--rotate|--get] [--to <path> [--as VAR]]
  arm --tab <id>
  set <NAME> [--from-clipboard | --wait | --stdin] [--to <path> [--as VAR]]
  abort
  list
  exec <NAME>... -- <cmd…>
  pipe <NAME> --confirmed -- <cmd…>
  deliver <NAME>
  deliveries [--prune]
  restart
  log [--limit N]
  import`;

/** Ends the command with an exit code and a (value-free) message. */
class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Ctx {
  d: SecretDeps;
  /** Every key value this run has held, scrubbed from any error text. */
  values: string[];
}

interface Parsed {
  pos: string[];
  flags: Map<string, string | true>;
  /** Argv after a bare `--`, if one was given. */
  rest?: string[];
}

const VALUE_FLAGS = new Set(['to', 'as', 'tab', 'limit']);

function parse(args: string[], allowed: string[]): Parsed {
  const sep = args.indexOf('--');
  const head = sep === -1 ? args : args.slice(0, sep);
  const out: Parsed = { pos: [], flags: new Map() };
  if (sep !== -1) out.rest = args.slice(sep + 1);
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (!a.startsWith('--')) {
      out.pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq === -1 ? undefined : eq);
    if (!allowed.includes(key)) throw new CliExit(2, `unknown option --${key}\n${USAGE}`);
    if (VALUE_FLAGS.has(key)) {
      const v = eq === -1 ? head[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new CliExit(2, `--${key} needs a value\n${USAGE}`);
      out.flags.set(key, v);
    } else {
      out.flags.set(key, true);
    }
  }
  return out;
}

function flag(p: Parsed, key: string): string | undefined {
  const v = p.flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

function allowName(name: string | undefined): string {
  if (!name) throw new CliExit(2, USAGE);
  try {
    assertNameAllowed(name);
  } catch (err) {
    throw new CliExit(2, (err as Error).message);
  }
  return name;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function hms(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The key's name in the provider's dashboard: `robin-<name>-<YYYYMMDD>`. */
export function dashboardKeyName(name: string, date: Date): string {
  return `robin-${name.toLowerCase().replace(/_/g, '-')}-${ymd(date)}`;
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function normalize(t: DeliveryTarget): DeliveryTarget {
  return t.kind === 'env-local' || t.kind === 'secret-file'
    ? { ...t, path: resolve(expandHome(t.path)) }
    : t;
}

function sameTarget(a: DeliveryTarget, b: DeliveryTarget): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function uniqueTargets(ts: DeliveryTarget[]): DeliveryTarget[] {
  const out: DeliveryTarget[] = [];
  for (const t of ts.map(normalize)) if (!out.some((x) => sameTarget(x, t))) out.push(t);
  return out;
}

function toTarget(p: Parsed, name: string): DeliveryTarget | undefined {
  const to = flag(p, 'to');
  const as = flag(p, 'as');
  if (as !== undefined && to === undefined) throw new CliExit(2, `--as needs --to\n${USAGE}`);
  if (to === undefined) return undefined;
  const v = as ?? name;
  if (as !== undefined) allowName(as);
  return { kind: 'env-local', path: resolve(expandHome(to)), var: v };
}

function describe(t: DeliveryTarget): string {
  switch (t.kind) {
    case 'robin-env':
      return `Robin .env ${t.var}`;
    case 'env-local':
      return `${t.path} (${t.var})`;
    case 'secret-file':
      return t.path;
    case 'pipe':
      return `pipe: ${t.argv.join(' ')}`;
  }
}

/** Where a target lives, for missing/failed lines. */
function where(t: DeliveryTarget): string {
  switch (t.kind) {
    case 'robin-env':
      return `Robin .env ${t.var}`;
    case 'env-local':
    case 'secret-file':
      return t.path;
    case 'pipe':
      return t.argv.join(' ');
  }
}

function refuseUnignored(ctx: Ctx, targets: DeliveryTarget[]): void {
  for (const t of targets) {
    if (t.kind === 'env-local' && checkIgnored(t.path, ctx.d.git) === 'not-ignored') {
      throw new CliExit(2, `refused: ${t.path} is not gitignored; add it to .gitignore first.`);
    }
  }
}

function refuseShadowed(ctx: Ctx, targets: DeliveryTarget[]): void {
  const daemonEnvPath = secretsPaths(ctx.d.userData).daemonEnv;
  for (const t of targets) {
    if (t.kind !== 'robin-env' && t.kind !== 'env-local') continue;
    const loc = findShadowing(t.var, {
      env: ctx.d.env,
      launchctlGetenv: ctx.d.launchctlGetenv,
      daemonEnvPath,
      target: t.kind,
    });
    if (loc) {
      throw new CliExit(
        2,
        `refused: ${t.var} is also defined in the ${loc}, which would override the delivered value. Remove it there, then re-run.`,
      );
    }
  }
}

/** A window file that exists but can't be parsed still counts as open. */
function windowExists(userData: string): boolean {
  try {
    return readWindow(userData) !== null;
  } catch {
    return true;
  }
}

function liveKeyWarning(provider: string, name: string, date: Date): string {
  return `A ${provider} key named ${dashboardKeyName(name, date)} may be live and unsaved — tell the operator.`;
}

function opDate(op: SecretOp | null, now: Date): Date {
  const d = op ? new Date(op.startedAt) : now;
  return Number.isNaN(d.getTime()) ? now : d;
}

// ── begin ────────────────────────────────────────────────────────────────

const ROTATE_CREATE_REVOKE =
  'At the revoke step, list the dashboard\'s key NAMES (never values) and ask the operator which to revoke, or "keep".';

export function beginLines(a: {
  recipe: Recipe | undefined;
  provider: string;
  name: string;
  mode: SecretOp['mode'];
  targets: DeliveryTarget[];
  now: Date;
}): string[] {
  const { recipe, provider, name, mode, targets, now } = a;
  const keyName = dashboardKeyName(name, now);
  const delivers = `delivers to: vault${targets.map((t) => `; ${describe(t)}`).join('')}`;
  if (!recipe) {
    return [
      `${provider} · manual · ${name}`,
      `dashboard key name: ${keyName}`,
      delivers,
      `No recipe for ${provider}. Drive the dashboard up to the reveal, ask for OK, then run: robin secret arm --tab <id>; click Create; robin secret set ${name} --wait`,
    ];
  }
  if (recipe.rotate === 'oauth') {
    const integration =
      (recipe.provider === 'google' ? googleIntegrationFor(name) : undefined) ??
      recipe.oauthIntegration ??
      provider;
    return [
      `${provider} · ${mode} · ${name}`,
      ...recipe.steps.map((s) => s.replace('<integration>', integration)),
    ];
  }
  const lines = [`${provider} · ${mode} · ${name}`, `url: ${recipe.startUrl}`, 'steps:'];
  recipe.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s}`);
  });
  if (mode !== 'get') lines.push(`dashboard key name: ${keyName}`);
  lines.push(delivers);
  const scripts: [string, string | undefined][] = [
    ['precheck', recipe.precheck],
    ['locateReveal', recipe.locateReveal],
    ['locateCopy', recipe.locateCopy],
  ];
  for (const [label, text] of scripts) {
    if (text === undefined) continue;
    lines.push(
      `script ${label} sha256 ${hashText(text)} (run with javascript_tool exactly as is):`,
    );
    lines.push(text);
  }
  const roll = recipe.rotate === 'roll';
  if (mode === 'rotate') {
    lines.push(
      roll
        ? 'Rotation rolls the existing key in place; there is no revoke step.'
        : ROTATE_CREATE_REVOKE,
    );
  }
  const fallback = `If a script returns {found:false}: robin secret set ${name} --wait`;
  if (mode === 'get') {
    lines.push(
      `next: tabs_create, then robin secret arm --tab <id>; navigate the tab to the url; run locateReveal if the key is hidden and locateCopy, clicking each {x,y}; robin secret set ${name} --from-clipboard. ${fallback}`,
    );
  } else {
    lines.push(
      `next: open the url, fill the form, run precheck (must return {ok:true}), ask the operator for OK, then: robin secret arm --tab <id>; click ${roll && mode === 'rotate' ? 'Roll' : 'Create'}; run locateCopy and click its {x,y}; robin secret set ${name} --from-clipboard. ${fallback}`,
    );
  }
  return lines;
}

function cmdBegin(ctx: Ctx, args: string[]): number {
  const p = parse(args, ['rotate', 'get', 'to', 'as']);
  const provider = p.pos[0];
  const name = allowName(p.pos[1]);
  if (!provider || p.pos.length > 2) throw new CliExit(2, USAGE);
  if (p.flags.has('rotate') && p.flags.has('get')) {
    throw new CliExit(2, '--rotate and --get are exclusive');
  }
  if (windowExists(ctx.d.userData)) throw new CliExit(2, ALREADY_OPEN);
  const recipe = getRecipe(provider);
  const to = toTarget(p, name);
  let mode: SecretOp['mode'] = 'manual';
  if (recipe) {
    const asked = p.flags.has('rotate') ? 'rotate' : p.flags.has('get') ? 'get' : undefined;
    mode = asked ?? (recipe.modes.includes('create') ? 'create' : recipe.modes[0]);
    if (!recipe.modes.includes(mode)) {
      throw new CliExit(2, `${provider} supports: ${recipe.modes.join(', ')}`);
    }
  }
  const now = ctx.d.now();
  if (recipe?.rotate === 'oauth') {
    // The token never renders: no op, no window.
    for (const l of beginLines({ recipe, provider, name, mode, targets: [], now })) ctx.d.out(l);
    return 0;
  }
  // A recipe's own target applies only to the name it was written for, so a
  // second key from the same provider never overwrites the first one's file.
  const targets = uniqueTargets([
    ...(recipe && recipe.defaultName === name ? [recipe.target] : []),
    ...(to ? [to] : []),
  ]);
  refuseUnignored(ctx, targets);
  refuseShadowed(ctx, targets);
  writeOp(ctx.d.userData, { provider, name, mode, targets, startedAt: now.toISOString() });
  for (const l of beginLines({ recipe, provider, name, mode, targets, now })) ctx.d.out(l);
  return 0;
}

// ── arm ──────────────────────────────────────────────────────────────────

function cmdArm(ctx: Ctx, args: string[]): number {
  const p = parse(args, ['tab']);
  const tabRaw = flag(p, 'tab');
  if (!tabRaw || !/^\d+$/.test(tabRaw) || p.pos.length) throw new CliExit(2, USAGE);
  const tab = Number(tabRaw);
  if (!Number.isSafeInteger(tab)) throw new CliExit(2, USAGE);
  const { userData } = ctx.d;
  if (windowExists(userData)) throw new CliExit(2, ALREADY_OPEN);
  const now = ctx.d.now();
  const op = readOp(userData);
  if (!op) {
    throw new CliExit(2, 'No pending secret op; run `robin secret begin <provider> <NAME>` first.');
  }
  if (now.getTime() - opDate(op, now).getTime() > OP_STALE_MS) {
    throw new CliExit(2, 'The pending secret op is over 1 h old; run `robin secret begin` again.');
  }
  const session = takeArmSession(userData, now);
  if (!session) {
    throw new CliExit(2, 'arm must run from a Claude session with the secret hooks installed');
  }
  if (session.tabId !== tab) {
    throw new CliExit(2, `The arm record is for tab ${session.tabId}, not ${tab}; nothing armed.`);
  }
  const recipe = getRecipe(op.provider);
  const expires = new Date(now.getTime() + WINDOW_MS);
  const win: SecretWindow = {
    sessionId: session.sessionId,
    tabId: tab,
    provider: op.provider,
    name: op.name,
    scriptHashes: recipe ? scriptHashes(recipe) : [],
    clipboardHashAtArm: hashText(ctx.d.clipboard.read()),
    openedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    status: 'open',
  };
  writeWindow(userData, win);
  appendLog(userData, {
    op: 'arm',
    provider: op.provider,
    name: op.name,
    session: session.sessionId,
  });
  ctx.d.out(`window open for tab ${tab} until ${hms(expires)}`);
  return 0;
}

// ── set ──────────────────────────────────────────────────────────────────

type Source = 'from-clipboard' | 'wait' | 'stdin' | 'stored';

async function readValue(
  ctx: Ctx,
  a: {
    source: Source;
    name: string;
    provider: string;
    win: SecretWindow | null;
    op: SecretOp | null;
    shape: RegExp;
  },
): Promise<string> {
  const { d } = ctx;
  const { name, provider, win, shape } = a;
  const retry = `Click Copy (locateCopy), or run robin secret set ${name} --wait.`;
  const sinceHash = win?.clipboardHashAtArm ?? '';
  switch (a.source) {
    case 'stored': {
      const v = getMaster(d.userData, name);
      if (v === undefined) {
        throw new CliExit(
          2,
          `${name} is not in the vault; copy it and run robin secret set ${name} --from-clipboard (or --stdin).`,
        );
      }
      return v;
    }
    case 'stdin': {
      const raw = await d.readStdin();
      const v = raw.replace(/\r?\n$/, '');
      if (v === '') throw new CliExit(1, 'Nothing on stdin; nothing saved.');
      if (!shape.test(v)) {
        throw new CliExit(1, `stdin doesn't match the ${provider} key shape; nothing saved.`);
      }
      return v;
    }
    case 'from-clipboard': {
      const r = takeFreshCopy(d.clipboard, sinceHash, shape);
      if (r.ok) return r.value;
      if (r.reason === 'unchanged') {
        throw new CliExit(
          1,
          `The clipboard hasn't changed since arm (no fresh copy); nothing saved. ${retry}`,
        );
      }
      if (r.reason === 'empty')
        throw new CliExit(1, `The clipboard is empty; nothing saved. ${retry}`);
      throw new CliExit(
        1,
        `The clipboard text doesn't match the ${provider} key shape; nothing saved. ${retry}`,
      );
    }
    case 'wait': {
      const now = d.now();
      if (win)
        updateWindow(d.userData, { expiresAt: new Date(now.getTime() + WAIT_MS).toISOString() });
      const r = await waitForFreshCopy(d.clipboard, sinceHash, shape, {
        timeoutMs: WAIT_MS,
        pollMs: POLL_MS,
        sleep: d.sleep,
        message: `Click Copy on the ${provider} tab`,
      });
      if (r.ok) return r.value;
      throw new CliExit(
        1,
        `No copy seen in 2 min. ${liveKeyWarning(provider, name, opDate(a.op, now))}`,
      );
    }
  }
}

function deliverOne(ctx: Ctx, t: DeliveryTarget, value: string): void {
  if (t.kind === 'env-local') deliverToEnvLocal(t.path, t.var, value, { git: ctx.d.git });
  else deliverFileTarget(ctx.d.userData, t, value);
}

function scrub(ctx: Ctx, msg: string): string {
  let s = msg;
  for (const v of [...ctx.values].sort((x, y) => y.length - x.length)) {
    if (v) s = s.split(v).join('[redacted]');
  }
  return s;
}

interface DeliveryReport {
  written: DeliveryTarget[];
  missing: DeliveryTarget[];
  failed: { target: DeliveryTarget; error: string }[];
  pipes: DeliveryTarget[];
}

function printReport(ctx: Ctx, r: DeliveryReport): void {
  const { out } = ctx.d;
  out(`delivered: ${r.written.length} files`);
  if (r.missing.length) {
    out(
      `missing: ${r.missing.map(where).join(', ')} (robin secret deliveries --prune forgets them)`,
    );
  }
  for (const f of r.failed) out(`failed: ${where(f.target)} — ${scrub(ctx, f.error)}`);
  for (const p of r.pipes) {
    if (p.kind === 'pipe') out(`pipes to re-run (ask the operator first): ${p.argv.join(' ')}`);
  }
}

async function cmdSet(ctx: Ctx, args: string[]): Promise<number> {
  const { d } = ctx;
  const p = parse(args, ['from-clipboard', 'wait', 'stdin', 'to', 'as']);
  const name = allowName(p.pos[0]);
  if (p.pos.length > 1) throw new CliExit(2, USAGE);
  const sources = (['from-clipboard', 'wait', 'stdin'] as const).filter((s) => p.flags.has(s));
  if (sources.length > 1) throw new CliExit(2, 'use one of --from-clipboard, --wait, --stdin');
  const now = d.now();

  const win = readWindow(d.userData);
  if (win && win.name !== name) {
    throw new CliExit(2, `The open secret window is for ${win.name}, not ${name}.`);
  }
  if (win && win.status === 'open' && isExpired(win, now)) {
    throw new CliExit(
      2,
      `Secret window expired with no save. Run \`robin secret abort\`, then tell the operator a ${win.provider} key may be live and unsaved.`,
    );
  }
  const pending = readOp(d.userData);
  const op = pending?.name === name ? pending : null;
  const provider = win?.provider ?? op?.provider;
  const label = provider ?? 'provider';
  const recipe = provider ? getRecipe(provider) : undefined;
  const shape = recipe?.shape ?? defaultShape;

  // Every check that can refuse runs before the value is read.
  const to = toTarget(p, name);
  const newTargets = uniqueTargets([...(op?.targets ?? []), ...(to ? [to] : [])]);
  const recorded = readDeliveries(d.userData)[name] ?? [];
  refuseUnignored(ctx, newTargets);
  refuseShadowed(ctx, [...newTargets, ...recorded]);

  // No source flag and no window: deliver the stored value (never a stray clipboard).
  const source: Source = sources[0] ?? (win ? 'from-clipboard' : 'stored');
  const value = await readValue(ctx, { source, name, provider: label, win, op, shape });
  ctx.values.push(value);

  const result = setMaster(d.userData, name, value);
  // From here the vault holds the value: nothing below may skip the deliveries,
  // the window status or the op cleanup, so each step catches its own failure.
  const problems: string[] = [];
  if (source === 'from-clipboard' || source === 'wait') {
    try {
      d.clipboard.clear();
    } catch (err) {
      problems.push(`could not clear the clipboard — ${scrub(ctx, (err as Error).message)}`);
    }
  }

  const report: DeliveryReport = { written: [], missing: [], failed: [], pipes: [] };
  if (result === 'saved') {
    // Registry as it was: new targets are added below, so nothing is written twice.
    try {
      const r = redeliverFileTargets(d.userData, name, value);
      report.written.push(...r.written);
      report.missing.push(...r.missing);
      report.failed.push(...r.failed);
      report.pipes.push(...r.pipes);
    } catch (err) {
      problems.push(`recorded deliveries — ${scrub(ctx, (err as Error).message)}`);
    }
  }
  for (const t of newTargets) {
    if (recorded.some((x) => sameTarget(x, t))) continue;
    if (t.kind === 'pipe') continue;
    try {
      deliverOne(ctx, t, value);
      addDelivery(d.userData, name, t);
      report.written.push(t);
    } catch (err) {
      report.failed.push({ target: t, error: scrub(ctx, (err as Error).message) });
    }
  }

  const attempt = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      problems.push(`${what} — ${scrub(ctx, (err as Error).message)}`);
    }
  };
  if (win) attempt('window status', () => updateWindow(d.userData, { status: 'saved' }));
  if (op) attempt('pending op', () => clearOp(d.userData));
  attempt('secret log', () =>
    appendLog(d.userData, {
      op: 'set',
      provider,
      name,
      fingerprint: fingerprint(value),
      session: win?.sessionId,
    }),
  );

  d.out(`${name} ${fingerprint(value)} · ${result === 'saved' ? 'saved' : 'already current'}`);
  printReport(ctx, report);
  for (const p of problems) d.out(`failed: ${p}`);
  if (win) d.out('next: close the tab');
  if (report.written.some((t) => t.kind === 'robin-env')) d.out('then: robin secret restart');
  return report.failed.length || problems.length ? 1 : 0;
}

// ── abort ────────────────────────────────────────────────────────────────

function cmdAbort(ctx: Ctx): number {
  const { d } = ctx;
  let win: SecretWindow | null = null;
  try {
    win = readWindow(d.userData);
  } catch {
    closeWindow(d.userData);
    d.out('removed an unreadable secret window file');
  }
  const op = readOp(d.userData);
  if (win?.status === 'open') {
    updateWindow(d.userData, { status: 'aborted' });
    d.out('window aborted; close the tab to end it');
    // Manual mode counts: its flow clicks Create too.
    if (op?.mode !== 'get') d.out(liveKeyWarning(win.provider, win.name, opDate(op, d.now())));
  } else if (win) {
    closeWindow(d.userData);
    d.out('window closed');
  } else {
    d.out('no secret window open');
  }
  if (op) {
    clearOp(d.userData);
    d.out(`pending ${op.provider} op for ${op.name} cleared`);
  }
  const subject = win ?? op;
  if (subject)
    appendLog(d.userData, { op: 'abort', provider: subject.provider, name: subject.name });
  return 0;
}

// ── list / deliveries / log ──────────────────────────────────────────────

interface LogEntry {
  op?: string;
  provider?: string;
  name?: string;
  fingerprint?: string;
  ts?: string;
}

function readLog(userData: string): LogEntry[] {
  const f = secretsPaths(userData).log;
  if (!existsSync(f)) return [];
  const out: LogEntry[] = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEntry);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

function cmdList(ctx: Ctx): number {
  const { d } = ctx;
  const vault = readEnvFile(secretsPaths(d.userData).vault);
  if (vault.size === 0) {
    d.out("vault is empty (robin secret import copies keys from Robin's .env)");
    return 0;
  }
  const deliveries = readDeliveries(d.userData);
  const lastSet = new Map<string, string>();
  for (const e of readLog(d.userData)) {
    if (e.op === 'set' && e.name && e.ts) lastSet.set(e.name, e.ts.slice(0, 10));
  }
  for (const [name, value] of [...vault].sort(([a], [b]) => a.localeCompare(b))) {
    const set = lastSet.get(name);
    const targets = deliveries[name] ?? [];
    d.out(
      `${name} ${fingerprint(value)}${set ? ` · set ${set}` : ''}${
        targets.length ? ` → ${targets.map(describe).join('; ')}` : ''
      }`,
    );
  }
  return 0;
}

function cmdDeliveries(ctx: Ctx, args: string[]): number {
  const { d } = ctx;
  const p = parse(args, ['prune']);
  if (p.flags.has('prune')) {
    const removed = pruneMissing(d.userData);
    d.out(removed.length ? `pruned: ${removed.map(where).join(', ')}` : 'nothing to prune');
  }
  const all = readDeliveries(d.userData);
  const names = Object.keys(all).sort();
  if (!names.length) d.out('no recorded deliveries');
  for (const n of names) d.out(`${n} → ${all[n].map(describe).join('; ')}`);
  return 0;
}

function cmdLog(ctx: Ctx, args: string[]): number {
  const p = parse(args, ['limit']);
  const raw = flag(p, 'limit') ?? '20';
  if (!/^\d+$/.test(raw)) throw new CliExit(2, '--limit takes a whole number');
  const entries = readLog(ctx.d.userData).slice(-Number(raw));
  if (!entries.length) ctx.d.out('no secret log entries');
  for (const e of entries) {
    ctx.d.out(
      [e.ts ?? '-', e.op ?? '-', e.provider ?? '-', e.name ?? '-', e.fingerprint ?? '']
        .join(' ')
        .trimEnd(),
    );
  }
  return 0;
}

// ── exec / pipe / deliver / restart / import ─────────────────────────────

function cmdExec(ctx: Ctx, args: string[]): number {
  const p = parse(args, []);
  if (!p.pos.length || !p.rest?.length) throw new CliExit(2, USAGE);
  const names = p.pos.map((n) => allowName(n));
  try {
    return runExec(names, p.rest, ctx.d.userData, ctx.d.spawn);
  } catch (err) {
    throw new CliExit(1, (err as Error).message);
  }
}

function cmdPipe(ctx: Ctx, args: string[]): number {
  const { d } = ctx;
  const p = parse(args, ['confirmed']);
  const name = allowName(p.pos[0]);
  if (p.pos.length > 1 || !p.rest?.length) throw new CliExit(2, USAGE);
  if (!p.flags.has('confirmed')) {
    throw new CliExit(
      2,
      `pipe sends ${name} to an outside service; ask the operator, then re-run with --confirmed`,
    );
  }
  const value = getMaster(d.userData, name);
  if (value === undefined) throw new CliExit(1, `${name} is not in the vault`);
  ctx.values.push(value);
  const code = runPipe(p.rest, value, d.spawn);
  if (code === 0) addDelivery(d.userData, name, { kind: 'pipe', argv: p.rest });
  appendLog(d.userData, { op: 'pipe', name, fingerprint: fingerprint(value) });
  d.out(`piped ${name} ${fingerprint(value)} to ${p.rest[0]} · exit ${code}`);
  return code === 0 ? 0 : 1;
}

function cmdDeliver(ctx: Ctx, args: string[]): number {
  const { d } = ctx;
  const p = parse(args, []);
  const name = allowName(p.pos[0]);
  if (p.pos.length > 1) throw new CliExit(2, USAGE);
  const value = getMaster(d.userData, name);
  if (value === undefined) throw new CliExit(1, `${name} is not in the vault`);
  ctx.values.push(value);
  const r = redeliverFileTargets(d.userData, name, value);
  appendLog(d.userData, { op: 'deliver', name, fingerprint: fingerprint(value) });
  d.out(`${name} ${fingerprint(value)}`);
  printReport(ctx, r);
  if (r.written.some((t) => t.kind === 'robin-env')) d.out('then: robin secret restart');
  return r.failed.length ? 1 : 0;
}

async function cmdRestart(ctx: Ctx): Promise<number> {
  const bounced = await ctx.d.restartDaemon(ctx.d.userData);
  ctx.d.out(bounced ? 'daemon restarted' : 'daemon not running; nothing to restart');
  ctx.d.out('run /mcp in open Claude sessions that use Robin tools');
  return 0;
}

function cmdImport(ctx: Ctx): number {
  const { d } = ctx;
  const names = importRobinEnv(d.userData);
  for (const n of names) {
    try {
      assertNameAllowed(n);
    } catch {
      continue; // kept in the vault (so it is redacted), never delivered
    }
    addDelivery(d.userData, n, { kind: 'robin-env', var: n });
    appendLog(d.userData, { op: 'import', name: n });
  }
  d.out(names.length ? `imported: ${names.join(', ')}` : 'nothing to import');
  return 0;
}

// ── entry ────────────────────────────────────────────────────────────────

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function withDefaults(deps: Partial<SecretDeps>): Promise<SecretDeps> {
  let userData = deps.userData;
  if (userData === undefined) {
    const { resolveUserDataDir } = await import('../../lib/paths.ts');
    userData = resolveUserDataDir();
  }
  return {
    clipboard: macClipboard,
    env: process.env,
    spawn: spawnSync,
    now: () => new Date(),
    out: (s) => console.log(s),
    restartDaemon: async (u) => {
      const { bounceDaemonIfRunning } = await import('./reauth.ts');
      return bounceDaemonIfRunning(u);
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    readStdin: readAllStdin,
    ...deps,
    userData,
  };
}

async function dispatch(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'begin':
      return cmdBegin(ctx, rest);
    case 'arm':
      return cmdArm(ctx, rest);
    case 'set':
      return cmdSet(ctx, rest);
    case 'abort':
      return cmdAbort(ctx);
    case 'list':
      return cmdList(ctx);
    case 'exec':
      return cmdExec(ctx, rest);
    case 'pipe':
      return cmdPipe(ctx, rest);
    case 'deliver':
      return cmdDeliver(ctx, rest);
    case 'deliveries':
      return cmdDeliveries(ctx, rest);
    case 'restart':
      return cmdRestart(ctx);
    case 'log':
      return cmdLog(ctx, rest);
    case 'import':
      return cmdImport(ctx);
    case 'install':
    case 'uninstall':
      ctx.d.out(`robin secret ${sub}: not yet available`);
      return 1;
    default:
      ctx.d.out(USAGE);
      return 2;
  }
}

export async function runSecretCommand(
  args: string[],
  deps: Partial<SecretDeps> = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const ctx: Ctx = { d: undefined as unknown as SecretDeps, values: [] };
  try {
    ctx.d = await withDefaults(deps);
    return await dispatch(ctx, args);
  } catch (err) {
    if (err instanceof CliExit) {
      if (err.message) out(scrub(ctx, err.message));
      return err.code;
    }
    out(`robin secret: ${scrub(ctx, err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}
