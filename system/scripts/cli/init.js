// `robin init` — bootstrap a fresh workspace from the installed package.
//
// Usage:
//   robin init [--target <dir>] [--no-prompt | --ci]
//              [--name <s>] [--tz <iana>] [--email <e>] [--platform <p>]
//
// Discovers the package root from this file's location (works whether the
// package is installed via `npm i -g`, linked, or run from a clone), then
// delegates to setup.js with packageRoot threaded so the scaffold, manifest,
// and migrations are sourced from the package — not from the empty workspace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './setup.js';

function parseArgs(argv) {
  const out = { ci: false, fields: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq === -1 ? a : a.slice(0, eq);
    const inlineVal = eq === -1 ? null : a.slice(eq + 1);
    const next = () => (inlineVal !== null ? inlineVal : argv[++i]);
    if (key === '--target') out.target = next();
    else if (key === '--no-prompt' || key === '--ci') out.ci = true;
    else if (key === '--name') out.fields.name = next();
    else if (key === '--tz' || key === '--timezone') out.fields.timezone = next();
    else if (key === '--email') out.fields.email = next();
    else if (key === '--platform') out.fields.platform = next();
    else if (key === '--assistant-name') out.fields.assistantName = next();
    else if (key === '-h' || key === '--help') out.help = true;
  }
  return out;
}

const HELP = `robin init — bootstrap a fresh workspace

usage:
  robin init [--target <dir>] [--no-prompt]
             [--name <s>] [--tz <iana>] [--email <e>]
             [--platform claude-code|cursor|gemini-cli|codex|antigravity]
             [--assistant-name <s>]

flags:
  --target <dir>   workspace root (default: $ROBIN_WORKSPACE or cwd)
  --no-prompt      non-interactive; use defaults + flag values
  --name           user's name
  --tz             IANA timezone (e.g. America/New_York)
  --email          contact email
  --platform       which AI coding tool will host Robin
  --assistant-name display name (default Robin)
`;

export async function cmdInit(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  // Package root: this file is .../system/scripts/cli/init.js → root is three up.
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..', '..');
  const scaffoldDir = resolve(packageRoot, 'system', 'scaffold');

  // Workspace target.
  const targetArg = args.target || process.env.ROBIN_WORKSPACE || process.cwd();
  const target = isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg);

  // Refuse to bootstrap on top of the package itself — that's the bug we're
  // working around (postinstall picking up CWD = package install dir).
  if (target === packageRoot) {
    process.stderr.write(
      `robin init: refusing to bootstrap into the package directory itself (${target}).\n` +
        '  Pass --target <dir> or set ROBIN_WORKSPACE.\n',
    );
    process.exit(2);
  }

  mkdirSync(target, { recursive: true });
  console.log(`[robin init] bootstrapping workspace at ${target}`);

  await setup(target, {
    ci: args.ci,
    fromInit: true,
    scaffoldDir,
    packageRoot,
  });

  // Pre-seed config from flags when running --no-prompt; setup.js skips
  // prompting in that mode and just leaves the file as-is, so callers
  // (control planes, scripts) can pin the user's identity here.
  if (args.ci && Object.keys(args.fields).length > 0) {
    const cfgPath = join(target, 'user-data', 'robin.config.json');
    let cfg = {};
    try {
      cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf-8')) : {};
    } catch {
      cfg = {};
    }
    cfg.user = cfg.user || {};
    if (args.fields.name) cfg.user.name = args.fields.name;
    if (args.fields.timezone) cfg.user.timezone = args.fields.timezone;
    if (args.fields.email) cfg.user.email = args.fields.email;
    if (args.fields.platform) cfg.platform = args.fields.platform;
    if (args.fields.assistantName) {
      cfg.assistant = cfg.assistant || {};
      cfg.assistant.name = args.fields.assistantName;
    }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`[robin init] wrote ${cfgPath}`);
  }

  console.log('[robin init] done');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await cmdInit(process.argv.slice(2));
}
