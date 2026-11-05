import { renameSync } from 'node:fs';

// Windows can briefly deny replacement while another process reads the old
// file (or an antivirus scans it). Retry the atomic operation, never unlink
// the destination or fall back to a partial overwrite. Permanent errors still
// preserve the existing file and propagate to the caller's cleanup handler.
export function atomicRenameSync(source, destination, {
  platform = process.platform, rename = renameSync,
  wait = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(source, destination); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 40) throw error;
      wait(25);
    }
  }
}
