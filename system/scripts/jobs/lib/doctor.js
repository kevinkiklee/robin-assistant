// Health checks for the job system. Catches structural drift between job defs,
// installed scheduler entries, and the surrounding workspace — the kind of
// breakage that silently fails until a job's next scheduled fire.
//
// Pure functions: take workspaceDir + discovered jobs + adapter, return findings.
// Wired into reconciler.js so checks run on every _robin-sync heartbeat (every
// 6 hours) and on every `robin jobs sync`.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LABEL_PREFIX, agentsDir, listEntries, plistPath } from '../installer/launchd.js';
import { expectedIntervalMs, parseCron } from './cron.js';

// Known non-job services that share the com.robin.* launchd namespace but
// aren't managed by the job reconciler. Doctor must NOT flag these as orphans.
// Add new names here if the user runs other long-lived services under
// ~/Library/LaunchAgents/com.robin.* (preferred: use a com.robin.user.*
// sub-namespace for new services to avoid editing this list).
const KNOWN_NON_JOB_LABELS = new Set(['discord-bot', 'discord-bot-watchdog', 'discord-bot-health']);

// severity: 'error' surfaces as failure-equivalent; 'warn' is informational.
function f(severity, code, target, message) {
  return { severity, code, target, message };
}

// Parse the first non-flag token of `command:` as the script path.
function commandScriptPath(cmd) {
  if (!cmd) return null;
  const tokens = cmd.trim().split(/\s+/);
  // tokens[0] is the interpreter (e.g. "node"); tokens[1] is the script
  for (let i = 1; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) return tokens[i];
  }
  return null;
}

export function checkJobDefs(workspaceDir, jobs) {
  const findings = [];
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled === false) continue;
    if (def.frontmatter.runtime !== 'node') continue;
    const script = commandScriptPath(def.frontmatter.command);
    if (!script) {
      findings.push(f('error', 'job-def-no-command', name, `runtime=node but no command: field with a script path`));
      continue;
    }
    const abs = isAbsolute(script) ? script : join(workspaceDir, script);
    if (!existsSync(abs)) {
      findings.push(f('error', 'job-def-script-missing', name, `command: script not found: ${script}`));
    }
  }
  return findings;
}

// Strip XML and pull a simple <key>X</key><...>Y</...> pair.
function extractPlistString(xml, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}
function extractProgramArguments(xml) {
  const m = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return [];
  return [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]);
}
function extractEnvVar(xml, name) {
  const env = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!env) return null;
  const re = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`);
  const m = env[1].match(re);
  return m ? m[1] : null;
}

function pathHasBinary(pathStr, name) {
  if (!pathStr) return false;
  for (const dir of pathStr.split(':')) {
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

export function checkPlists(workspaceDir, jobs, opts = {}) {
  const findings = [];
  // Only macOS launchd is wired today; if no plists exist we no-op cleanly.
  const dir = (opts.agentsDir || agentsDir)();
  if (!existsSync(dir)) return findings;
  let entries;
  try {
    entries = (opts.listEntries || listEntries)();
  } catch (err) {
    findings.push(f('error', 'plist-list-failed', '_doctor', `cannot list LaunchAgents: ${err.message}`));
    return findings;
  }
  const enabledJobNames = new Set();
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled !== false) enabledJobNames.add(name);
  }
  const allKnownJobNames = new Set(jobs.keys());
  const pathOf = opts.plistPath || plistPath;
  for (const name of entries) {
    const p = pathOf(name);
    let xml;
    try {
      xml = readFileSync(p, 'utf-8');
    } catch (err) {
      findings.push(f('warn', 'plist-unreadable', name, `cannot read plist: ${err.message}`));
      continue;
    }
    // Orphan: plist exists but no matching job def at all (not just disabled)
    if (!allKnownJobNames.has(name)) {
      if (KNOWN_NON_JOB_LABELS.has(name)) continue;
      findings.push(f('warn', 'plist-orphan', name, `installed plist has no matching job def — manually delete or move under ${LABEL_PREFIX}user.* namespace`));
      continue;
    }
    const def = jobs.get(name);
    // Workspace mismatch — plist points at a different repo dir
    const wd = extractPlistString(xml, 'WorkingDirectory');
    if (wd && wd !== workspaceDir) {
      findings.push(f('error', 'plist-workspace-mismatch', name, `WorkingDirectory ${wd} != workspace ${workspaceDir} — run \`robin jobs sync --force\``));
    }
    // Script path in argv must exist
    const argv = extractProgramArguments(xml);
    if (argv.length >= 2 && !existsSync(argv[1])) {
      findings.push(f('error', 'plist-argv-missing', name, `argv[1] does not exist: ${argv[1]}`));
    }
    // PATH must resolve node (for runtime=node) and node+claude (for runtime=agent)
    const path = extractEnvVar(xml, 'PATH');
    if (def.frontmatter.runtime === 'node' && !pathHasBinary(path, 'node')) {
      findings.push(f('error', 'plist-path-no-node', name, `PATH cannot resolve 'node': ${path || '(unset)'}`));
    }
    if (def.frontmatter.runtime === 'agent') {
      if (!pathHasBinary(path, 'node')) {
        findings.push(f('error', 'plist-path-no-node', name, `PATH cannot resolve 'node': ${path || '(unset)'}`));
      }
      if (!pathHasBinary(path, 'claude')) {
        findings.push(f('error', 'plist-path-no-claude', name, `PATH cannot resolve 'claude': ${path || '(unset)'}`));
      }
    }
  }
  // Enabled job defs that have no installed plist (catches missed installs after force-sync skip)
  for (const name of enabledJobNames) {
    const def = jobs.get(name);
    if (!def.frontmatter.schedule) continue;
    if (!entries.includes(name)) {
      findings.push(f('error', 'plist-missing', name, `enabled job has no installed plist — run \`robin jobs sync --force\``));
    }
  }
  return findings;
}

// Catches enabled jobs that aren't actually running on schedule. Two cases:
//   job-never-ran: enabled job has no state JSON, or state.last_run_at is null.
//     Plist may be wired wrong (broken PATH/WorkingDirectory) but no run ever
//     produced a failure to surface — this would otherwise be silent.
//   job-overdue: state.next_run_at is past by >2× the cron interval, meaning
//     the scheduler has stopped firing for a job that previously ran.
export function checkStaleness(workspaceDir, jobs, states, opts = {}) {
  const findings = [];
  if (!states) return findings;
  const now = opts.now || new Date();
  for (const [name, def] of jobs) {
    if (def.frontmatter.enabled === false) continue;
    if (!def.frontmatter.schedule) continue;
    const state = states.get(name);
    if (!state || !state.last_run_at) {
      findings.push(f('warn', 'job-never-ran', name, `enabled job has no recorded run — kickstart manually (\`launchctl kickstart gui/$(id -u)/${LABEL_PREFIX}${name}\`) and check the log`));
      continue;
    }
    if (!state.next_run_at) continue;
    let cron;
    try { cron = parseCron(def.frontmatter.schedule); } catch { continue; }
    const interval = expectedIntervalMs(cron);
    if (!Number.isFinite(interval) || interval <= 0) continue;
    const overdueBy = now.getTime() - new Date(state.next_run_at).getTime();
    if (overdueBy > 2 * interval) {
      const hours = Math.round(overdueBy / 3600000);
      findings.push(f('warn', 'job-overdue', name, `next_run_at ${state.next_run_at} overdue by ~${hours}h (>2× interval) — scheduler may have stopped firing`));
    }
  }
  return findings;
}

export function runDoctor(workspaceDir, jobs, opts = {}) {
  const findings = [];
  try {
    findings.push(...checkJobDefs(workspaceDir, jobs));
  } catch (err) {
    findings.push(f('error', 'doctor-self-error', 'checkJobDefs', err.message));
  }
  try {
    findings.push(...checkPlists(workspaceDir, jobs, opts));
  } catch (err) {
    findings.push(f('error', 'doctor-self-error', 'checkPlists', err.message));
  }
  try {
    findings.push(...checkStaleness(workspaceDir, jobs, opts.states, opts));
  } catch (err) {
    findings.push(f('error', 'doctor-self-error', 'checkStaleness', err.message));
  }
  return findings;
}

// Render findings as the `## Health check` section of failures.md.
export function renderHealthSection(findings) {
  const lines = ['## Health check'];
  if (!findings || findings.length === 0) {
    lines.push('(none)');
    lines.push('');
    return lines.join('\n');
  }
  // sort: errors first, then warns, then by code+target for stability
  const sorted = [...findings].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return a.target.localeCompare(b.target);
  });
  lines.push('| Severity | Code | Target | Message |');
  lines.push('|----------|------|--------|---------|');
  for (const r of sorted) {
    const msg = (r.message || '').replace(/\|/g, '\\|').slice(0, 200);
    lines.push(`| ${r.severity} | ${r.code} | ${r.target} | ${msg} |`);
  }
  lines.push('');
  return lines.join('\n');
}
