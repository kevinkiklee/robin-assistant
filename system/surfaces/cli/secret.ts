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
import { type ExecFn, MAC_TOOLS, realExec, TOOL_ENV } from '../../lib/secrets/mac-tools.ts';
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
  /** Operator-bound yes/no (macOS dialog). True only for an explicit "Send". */
  confirm: (title: string, body: string) => boolean;
  /** HOME whose ~/.claude gets the hooks and rule file (`install`/`uninstall`). */
  home: string;
  /** Compiled hooks root for `install`; undefined → this repo's dist/. */
  distRoot?: string;
}

const WINDOW_MS = 120_000;
const WAIT_MS = 120_000;
const POLL_MS = 1_000;
const OP_STALE_MS = 60 * 60_000;
const WAIT_HINT = '— give the Bash call a timeout of at least 150000 ms';
const ALREADY_OPEN = 'A secret window is already open; run `robin secret abort` first.';

const USAGE = `usage: robin secret <command>
  begin <provider> <NAME> [--rotate|--get] [--to <path> [--as VAR]]
  arm --tab <id>
  set <NAME> [--from-clipboard | --wait | --stdin] [--to <path> [--as VAR]]
  abort
  list
  exec <NAME>... -- <cmd…>
  pipe <NAME> -- <cmd…>          (a dialog asks the operator first)
  deliver <NAME>
  deliveries [--prune]
  restart
  log [--limit N]
  import
  install | uninstall            (Claude Code hooks + global rule file)`;

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

/** Where an existing definition would override what `t` delivers, or null. */
function shadowOf(ctx: Ctx, t: DeliveryTarget): string | null {
  if (t.kind !== 'robin-env' && t.kind !== 'env-local') return null;
  return findShadowing(t.var, {
    env: ctx.d.env,
    launchctlGetenv: ctx.d.launchctlGetenv,
    daemonEnvPath: secretsPaths(ctx.d.userData).daemonEnv,
    target: t.kind,
  });
}

function refuseShadowed(ctx: Ctx, targets: DeliveryTarget[]): void {
  for (const t of targets) {
    const loc = shadowOf(ctx, t);
    if (loc && (t.kind === 'robin-env' || t.kind === 'env-local')) {
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

/** Unparseable startedAt counts as stale. */
function opStale(op: SecretOp, now: Date): boolean {
  const t = new Date(op.startedAt).getTime();
  return Number.isNaN(t) || now.getTime() - t > OP_STALE_MS;
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
    // `mode` is 'get' / 'rotate' when begin was given --get / --rotate.
    const head = `${provider} · manual${mode === 'manual' ? '' : ` ${mode}`} · ${name}`;
    if (mode === 'get') {
      return [
        head,
        delivers,
        `No recipe for ${provider}. Get order: tabs_create, then robin secret arm --tab <id>; navigate the tab to the page that shows the key; robin secret set ${name} --wait ${WAIT_HINT}`,
      ];
    }
    const lines = [
      head,
      `dashboard key name: ${keyName}`,
      delivers,
      `No recipe for ${provider}. Drive the dashboard up to the reveal, ask for OK, then run: robin secret arm --tab <id>; click Create; robin secret set ${name} --wait ${WAIT_HINT}`,
    ];
    if (mode === 'rotate') lines.push(ROTATE_CREATE_REVOKE);
    return lines;
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
    ['inspectReveal', recipe.inspectReveal],
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
  const fallback = `If a script returns {found:false}: robin secret set ${name} --wait ${WAIT_HINT}`;
  if (mode === 'get') {
    lines.push(
      `next: tabs_create, then robin secret arm --tab <id>; navigate the tab to the url; run locateReveal if the key is hidden and locateCopy, clicking each {x,y}; robin secret set ${name} --from-clipboard. ${fallback}`,
    );
  } else {
    lines.push(
      `next: open the url, fill the form, ${recipe.precheck !== undefined ? 'run precheck (must return {ok:true}), ' : ''}ask the operator for OK, then: robin secret arm --tab <id>; click ${roll && mode === 'rotate' ? 'Roll' : 'Create'}; run locateCopy and click its {x,y}; robin secret set ${name} --from-clipboard. ${fallback}`,
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
  if (!recipe) {
    // Manual --get mints nothing; manual --rotate mints like create.
    if (p.flags.has('get')) mode = 'get';
    else if (p.flags.has('rotate')) mode = 'rotate';
  } else {
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
  // Every recorded target of NAME gets the new value too, so check them all now.
  refuseShadowed(ctx, [...targets, ...(readDeliveries(ctx.d.userData)[name] ?? [])]);
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
  if (opStale(op, now)) {
    throw new CliExit(2, 'The pending secret op is over 1 h old; run `robin secret begin` again.');
  }
  const session = takeArmSession(userData, now);
  if (!session) {
    throw new CliExit(
      2,
      "arm must be run as a bare command exactly `robin secret arm --tab <id>` within 10 s of the guard recording it (no cd/&&, no --tab=); if hooks aren't installed run `robin secret install`",
    );
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
  const retry = `Click Copy (locateCopy), or run robin secret set ${name} --wait ${WAIT_HINT}.`;
  switch (a.source) {
    case 'stored': {
      const v = getMaster(d.userData, name);
      if (v === undefined) {
        throw new CliExit(
          2,
          `${name} is not in the vault; copy it with robin secret set ${name} --wait ${WAIT_HINT}, or --stdin.`,
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
      // cmdSet refuses this source without a window, so the arm-time hash exists.
      const r = takeFreshCopy(d.clipboard, win?.clipboardHashAtArm ?? '', shape);
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
      // Without a window the baseline is the clipboard as it is now, so only a
      // copy made during the wait counts — never whatever was already there.
      const sinceHash = win ? win.clipboardHashAtArm : hashText(d.clipboard.read());
      const r = await waitForFreshCopy(d.clipboard, sinceHash, shape, {
        timeoutMs: WAIT_MS,
        pollMs: POLL_MS,
        sleep: d.sleep,
        message: `Click Copy on the ${provider} tab`,
      });
      if (r.ok) return r.value;
      if (!a.op) throw new CliExit(1, 'No copy seen in 2 min.');
      if (a.op.mode === 'get') throw new CliExit(1, 'No copy seen in 2 min; nothing saved.');
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
  /** Written, but the registry write failed: a rotation won't reach it. */
  unrecorded?: { target: DeliveryTarget; error: string }[];
  missing: DeliveryTarget[];
  failed: { target: DeliveryTarget; error: string }[];
  pipes: DeliveryTarget[];
}

function printReport(ctx: Ctx, name: string, r: DeliveryReport): void {
  const { out } = ctx.d;
  out(`delivered: ${r.written.length} files`);
  for (const u of r.unrecorded ?? []) {
    out(
      `delivered but not recorded (a rotation won't update it): ${where(u.target)} — ${scrub(ctx, u.error)}`,
    );
  }
  if (r.missing.length) {
    out(
      `missing: ${r.missing.map(where).join(', ')} (robin secret deliveries --prune forgets them)`,
    );
  }
  for (const f of r.failed) out(`failed: ${where(f.target)} — ${scrub(ctx, f.error)}`);
  for (const p of r.pipes) {
    if (p.kind === 'pipe') {
      out(
        `pipes to re-run: run \`robin secret pipe ${name} -- ${p.argv.join(' ')}\` (a dialog asks the operator)`,
      );
    }
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
  // After a mint (create / rotate / manual) the key already exists at the
  // provider, so never refuse: save it, deliver what isn't shadowed, and
  // report the rest. Otherwise refuse before the value is read.
  const minted = op !== null && op.mode !== 'get';
  const shadowed = new Map<string, string>();
  if (minted) {
    for (const t of uniqueTargets([...newTargets, ...recorded])) {
      const loc = shadowOf(ctx, t);
      if (loc) shadowed.set(JSON.stringify(t), loc);
    }
  } else {
    refuseShadowed(ctx, [...newTargets, ...recorded]);
  }
  const shadowReason = (t: DeliveryTarget): string | undefined => {
    const loc = shadowed.get(JSON.stringify(normalize(t)));
    return loc ? `shadowed by ${loc}` : undefined;
  };

  // No source flag and no window: deliver the stored value (never a stray clipboard).
  const source: Source = sources[0] ?? (win ? 'from-clipboard' : 'stored');
  if (!win && (source === 'from-clipboard' || source === 'wait')) {
    if (op && op.mode !== 'get' && !opStale(op, now)) {
      throw new CliExit(
        2,
        `pending ${op.mode} for ${name} has no armed window; run \`robin secret arm --tab <id>\` first`,
      );
    }
    if (source === 'from-clipboard') {
      throw new CliExit(
        2,
        `no armed window — use --wait so the copy is fresh ${WAIT_HINT}, or --stdin`,
      );
    }
  }
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
      const r = redeliverFileTargets(d.userData, name, value, { skip: shadowReason });
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
    const skip = shadowReason(t);
    if (skip) {
      report.failed.push({ target: t, error: skip });
      continue;
    }
    try {
      deliverOne(ctx, t, value);
    } catch (err) {
      report.failed.push({ target: t, error: scrub(ctx, (err as Error).message) });
      continue;
    }
    report.written.push(t);
    try {
      addDelivery(d.userData, name, t);
    } catch (err) {
      report.unrecorded = [
        ...(report.unrecorded ?? []),
        { target: t, error: scrub(ctx, (err as Error).message) },
      ];
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
  printReport(ctx, name, report);
  for (const p of problems) d.out(`failed: ${p}`);
  if (win) d.out('next: close the tab');
  if (report.written.some((t) => t.kind === 'robin-env')) d.out('then: robin secret restart');
  return report.failed.length || problems.length || report.unrecorded?.length ? 1 : 0;
}

// ── abort ────────────────────────────────────────────────────────────────

function cmdAbort(ctx: Ctx): number {
  const { d } = ctx;
  let win: SecretWindow | null = null;
  let unreadable = false;
  try {
    win = readWindow(d.userData);
  } catch {
    unreadable = true;
  }
  const op = readOp(d.userData);
  const now = d.now();
  // Manual mode counts as live-key risk: its flow clicks Create too.
  if (unreadable) {
    closeWindow(d.userData);
    d.out('window closed (its file was unreadable)');
    if (op && op.mode !== 'get') d.out(liveKeyWarning(op.provider, op.name, opDate(op, now)));
  } else if (win?.status === 'open') {
    updateWindow(d.userData, { status: 'aborted' });
    d.out('window aborted; close the tab to end it');
    if (op?.mode !== 'get') d.out(liveKeyWarning(win.provider, win.name, opDate(op, now)));
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
  const limit = Number(raw);
  if (limit === 0) return 0; // slice(-0) would return every entry
  const entries = readLog(ctx.d.userData).slice(-limit);
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
  const p = parse(args, []);
  const name = allowName(p.pos[0]);
  const argv = p.rest;
  if (p.pos.length > 1 || !argv?.length) throw new CliExit(2, USAGE);
  const value = getMaster(d.userData, name);
  if (value === undefined) throw new CliExit(1, `${name} is not in the vault`);
  ctx.values.push(value);
  // Operator-bound: an agent's own say-so (a flag) is not consent to send a key out.
  const shown = argv.map(dialogWord).join(' ');
  const approved = d.confirm(
    'Robin: send a key to an outside service?',
    `Send ${name} on stdin to:\n\n${shown}\n\nOnly Send if you asked for this.`,
  );
  if (!approved) {
    appendLog(d.userData, { op: 'pipe-denied', name });
    throw new CliExit(
      2,
      `The operator did not approve sending ${name} to ${argv[0]}; nothing sent.`,
    );
  }
  const code = runPipe(argv, value, d.spawn);
  if (code === 0) addDelivery(d.userData, name, { kind: 'pipe', argv });
  appendLog(d.userData, { op: 'pipe', name, fingerprint: fingerprint(value) });
  d.out(`piped ${name} ${fingerprint(value)} to ${argv[0]} · exit ${code}`);
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
  printReport(ctx, name, r);
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

async function cmdInstall(ctx: Ctx): Promise<number> {
  const { d } = ctx;
  const { installSecretHooks } = await import('../../lib/secrets/install.ts');
  const { installRuleFile } = await import('../../lib/secrets/rule-file.ts');
  const r = installSecretHooks({ home: d.home, userData: d.userData, distRoot: d.distRoot });
  if (r.skipped) {
    // Nothing installed, rule file included: it would send agents to a flow
    // whose `arm` needs the hooks.
    d.out(`secret hooks: skipped — ${r.message}`);
    return 1;
  }
  d.out(`hooks: ${r.replaced ? 'updated' : 'installed'} PreToolUse + PostToolUse in ${r.path}`);
  d.out(`rule file: ${installRuleFile(d.home)}`);
  return 0;
}

async function cmdUninstall(ctx: Ctx): Promise<number> {
  const { d } = ctx;
  const { uninstallSecretHooks } = await import('../../lib/secrets/install.ts');
  const { uninstallRuleFile } = await import('../../lib/secrets/rule-file.ts');
  const r = uninstallSecretHooks({ home: d.home });
  if (r.unreadable) d.out(`hooks: settings.json unreadable (${r.path}); nothing removed`);
  else d.out(r.replaced ? `hooks: removed from ${r.path}` : 'hooks: none installed');
  d.out(uninstallRuleFile(d.home) ? 'rule file: removed' : 'rule file: none installed');
  return r.unreadable ? 1 : 0;
}

// ── entry ────────────────────────────────────────────────────────────────

/** AppleScript string literal: escape `\` and `"`, spell out newlines, drop other controls. */
export function appleScriptString(s: string): string {
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  return `"${body}"`;
}

/** The dialog script; only an explicit "Send" (not a give-up) approves. */
export function confirmScript(title: string, body: string): string {
  return `display dialog ${appleScriptString(body)} with title ${appleScriptString(title)} buttons {"Deny", "Send"} default button "Deny" cancel button "Deny" giving up after 120`;
}

/**
 * The operator dialog via /usr/bin/osascript (absolute path, fixed env: a fake
 * osascript on PATH must not be able to "click" Send). Deny closes the dialog
 * with error -128 (exec throws) → false.
 */
export function macConfirmWith(exec: ExecFn): (title: string, body: string) => boolean {
  return (title, body) => {
    try {
      const out = String(
        exec(MAC_TOOLS.osascript, ['-e', confirmScript(title, body)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 130_000,
          env: TOOL_ENV,
        }),
      );
      return /button returned:Send\b/.test(out) && !/gave up:true/.test(out);
    } catch {
      return false;
    }
  };
}

/**
 * An argv word as the dialog shows it. Anything outside printable ASCII
 * (bidi overrides, zero-width chars, newlines) is spelled `\uXXXX`, so the
 * dialog can't be made to show a different command than the one that runs.
 */
export function dialogWord(a: string): string {
  if (/^[\w@%+=:,./-]+$/.test(a)) return a;
  const esc = a
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${esc}"`;
}

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
    confirm: macConfirmWith(realExec),
    home: homedir(),
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
      return cmdInstall(ctx);
    case 'uninstall':
      return cmdUninstall(ctx);
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
