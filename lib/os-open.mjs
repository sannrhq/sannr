// The OS opener for a file or URL, described without starting anything.
//
// macOS `open` and freedesktop `xdg-open` take the target as an argument and
// exit non-zero when they could not hand it on. Windows has no such command:
// explorer.exe splits its arguments on commas and exits 1 even after it opened
// the target, so a caller cannot tell success from failure, and `cmd /c start`
// needs ^-escaping of `&` and `^`. PowerShell's Start-Process hands the target
// to ShellExecute, which opens the default browser for a URL and the
// associated application for a file, and PowerShell exits 0 only when
// ShellExecute accepted it. The script is a constant and reads the target from
// an environment variable, so no character of the target is ever parsed as
// PowerShell or cmd syntax. The absolute path avoids Windows' current-directory
// search for a bare `powershell.exe`, which could be the repository itself.
import { win32 } from 'node:path';

export const OS_OPEN_TARGET_ENV = 'OS_OPEN_TARGET';

// The Windows directory when the environment does not name it; composed so
// that no tracked file carries a machine-shaped absolute path.
const windowsDirectory = env => env.SystemRoot || env.SYSTEMROOT || env.windir || [env.SystemDrive || 'C:', 'Windows'].join(win32.sep);

/** The launcher for a target on a platform: command, args and any extra env. */
export function osOpenLaunch(target, { platform = process.platform, env = process.env, variable = OS_OPEN_TARGET_ENV } = {}) {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') return {
    command: win32.join(windowsDirectory(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath $env:${variable}`],
    env: { [variable]: target },
  };
  return { command: 'xdg-open', args: [target] };
}

/** Spawn options for a launch: its env over the base env, and no console window on Windows. */
export const osOpenSpawnOptions = (launch, base = process.env) =>
  ({ windowsHide: true, ...(launch.env ? { env: { ...base, ...launch.env } } : {}) });
