import { linkSync, statSync, symlinkSync } from 'node:fs';

// Windows file symlinks need Administrator or Developer Mode. Exercise the
// same no-alias boundary as a normal user with hardlinked files and junction
// directories. POSIX runs retain actual symbolic links. No safety case is
// skipped: the original bytes must survive and the product must refuse it.
export function unsafeAliasSync(target, link) {
  if (process.platform !== 'win32') return symlinkSync(target, link);
  return statSync(target).isDirectory() ? symlinkSync(target, link, 'junction') : linkSync(target, link);
}
