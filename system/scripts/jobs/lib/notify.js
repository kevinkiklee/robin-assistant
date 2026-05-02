// Cross-platform native OS notifications.
// All implementations spawn detached + unref'd so the runner exits immediately.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

function fireDetached(cmd, args, env = {}) {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...env },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// macOS — `osascript -e 'display notification "<body>" with title "<title>"'`
function notifyMac({ title, body }) {
  const t = String(title).replace(/"/g, '\\"');
  const b = String(body).replace(/"/g, '\\"');
  const script = `display notification "${b}" with title "${t}"`;
  return fireDetached('osascript', ['-e', script]);
}

// Linux — notify-send if DISPLAY/WAYLAND_DISPLAY available
function notifyLinux({ title, body }) {
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!hasDisplay) return false;
  return fireDetached('notify-send', ['-a', 'Robin', '-i', 'dialog-warning', String(title), String(body)]);
}

// Windows — built-in WinRT toast via PowerShell, no module dep
function notifyWindows({ title, body }) {
  const t = String(title).replace(/'/g, "''");
  const b = String(body).replace(/'/g, "''");
  const ps = `
    [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($template.CreateTextNode('${t}')) | Out-Null
    $texts.Item(1).AppendChild($template.CreateTextNode('${b}')) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Robin').Show($toast)
  `;
  return fireDetached('powershell', ['-NoLogo', '-NoProfile', '-Command', ps]);
}

// Best-effort. Returns true if a notification was attempted, false if the
// platform doesn't support it OR a precondition is missing (e.g. no DISPLAY).
export function notify({ title, body }) {
  if (process.env.ROBIN_NO_NOTIFY) return false;
  switch (platform()) {
    case 'darwin':
      return notifyMac({ title, body });
    case 'linux':
      return notifyLinux({ title, body });
    case 'win32':
      return notifyWindows({ title, body });
    default:
      return false;
  }
}

// Probe at reconcile time — caches result in caller's state.
export function probeNotificationCapability() {
  switch (platform()) {
    case 'darwin':
      return { available: true, mechanism: 'osascript' };
    case 'linux':
      if (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
        return { available: false, reason: 'no-display' };
      }
      return { available: true, mechanism: 'notify-send' };
    case 'win32':
      return { available: true, mechanism: 'powershell-toast' };
    default:
      return { available: false, reason: 'unsupported-platform' };
  }
}
