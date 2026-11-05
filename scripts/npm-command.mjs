import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// npm.cmd is a shell script, not a native executable. Run npm with this
// Node interpreter on Windows; never route package arguments through cmd.exe.
export function runNpm(args, options = {}) {
  const script = process.env.npm_execpath ?? (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null);
  if (script && existsSync(script)) return execFileSync(process.execPath, [script, ...args], options);
  if (process.platform === 'win32') throw new Error('The npm JavaScript entry point is unavailable.');
  return execFileSync('npm', args, options);
}
