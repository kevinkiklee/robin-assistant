// Windows Task Scheduler adapter. Translates a job def to a PowerShell
// invocation of Register-ScheduledTask. Unsupported cron patterns return null
// from `cronToTaskTrigger`; the installer skips those with a warning.

import { spawnSync } from 'node:child_process';
import { parseCron } from '../../lib/jobs/cron.js';

export const TASK_FOLDER = '\\Robin\\';

// Build a PowerShell command string for Register-ScheduledTask. Returns null
// if the cron is not losslessly representable in Task Scheduler primitives.
export function buildRegisterCommand({ name, robinPath, workspaceDir, schedule }) {
  const trigger = cronToTaskTrigger(schedule);
  if (!trigger) return null;
  const escapedRobin = robinPath.replace(/'/g, "''");
  const escapedWs = workspaceDir.replace(/'/g, "''");
  const escapedName = name.replace(/'/g, "''");
  // We use an array of triggers when the cron requires multiple. PowerShell
  // accepts an array via `,`-separation in the splat.
  const triggerExpr = Array.isArray(trigger)
    ? `@(${trigger.map((t) => t.expr).join(', ')})`
    : trigger.expr;

  return [
    `$action = New-ScheduledTaskAction -Execute '${escapedRobin}' -Argument 'run ${escapedName}' -WorkingDirectory '${escapedWs}'`,
    `$trigger = ${triggerExpr}`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries`,
    `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U`,
    `Register-ScheduledTask -TaskName '${escapedName}' -TaskPath '${TASK_FOLDER}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join('; ');
}

export function buildUnregisterCommand(name) {
  const escapedName = name.replace(/'/g, "''");
  return `Unregister-ScheduledTask -TaskName '${escapedName}' -TaskPath '${TASK_FOLDER}' -Confirm:$false -ErrorAction SilentlyContinue | Out-Null`;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function cronToTaskTrigger(cronExpr) {
  let c;
  try {
    c = parseCron(cronExpr);
  } catch {
    return null;
  }
  // Only single-minute / single-hour patterns are supported in v1; multi-fire
  // expressions return an array.
  const dailyAtMinHour = (mn, hr) =>
    `New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours(${hr}).AddMinutes(${mn}))`;
  const weeklyAt = (mn, hr, wd) =>
    `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${DOW[wd]} -At ([DateTime]::Today.AddHours(${hr}).AddMinutes(${mn}))`;

  // Standard `0 4 * * *` style
  if (c.minute.length === 1 && c.hour.length === 1 && c.dayOfMonth.length === 31 && c.month.length === 12 && c.dayOfWeek.length === 7) {
    return { expr: dailyAtMinHour(c.minute[0], c.hour[0]) };
  }
  // Weekly: `0 10 * * 0`
  if (c.minute.length === 1 && c.hour.length === 1 && c.dayOfMonth.length === 31 && c.month.length === 12 && c.dayOfWeek.length >= 1 && c.dayOfWeek.length <= 7) {
    if (c.dayOfWeek.length === 7) return { expr: dailyAtMinHour(c.minute[0], c.hour[0]) };
    if (c.dayOfWeek.length === 1) {
      return { expr: weeklyAt(c.minute[0], c.hour[0], c.dayOfWeek[0]) };
    }
    const triggers = c.dayOfWeek.map((wd) => ({ expr: weeklyAt(c.minute[0], c.hour[0], wd) }));
    return triggers;
  }
  // Multi-hour daily: `15 */6 * * *` → array of daily triggers, one per hour.
  if (
    c.minute.length === 1 &&
    c.hour.length > 1 &&
    c.dayOfMonth.length === 31 &&
    c.month.length === 12 &&
    c.dayOfWeek.length === 7
  ) {
    const triggers = c.hour.map((hr) => ({ expr: dailyAtMinHour(c.minute[0], hr) }));
    return triggers;
  }
  return null;
}

function powershell(cmd) {
  return spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', cmd], { stdio: 'pipe' });
}

export function installEntry({ name, robinPath, workspaceDir, schedule }) {
  const cmd = buildRegisterCommand({ name, robinPath, workspaceDir, schedule });
  if (!cmd) return { ok: false, stderr: `cron not representable: ${schedule}` };
  const r = powershell(cmd);
  return { ok: r.status === 0, stderr: r.stderr?.toString() || '' };
}

export function uninstallEntry(name) {
  const r = powershell(buildUnregisterCommand(name));
  return { ok: r.status === 0, stderr: r.stderr?.toString() || '' };
}

export function listEntries() {
  const cmd = `Get-ScheduledTask -TaskPath '${TASK_FOLDER}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`;
  const r = powershell(cmd);
  if (r.status !== 0) return [];
  return (r.stdout?.toString() || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
