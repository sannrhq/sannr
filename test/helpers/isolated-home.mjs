// Imported first by every test file that runs the CLI, the MCP server or a
// packed copy of the package. It gives the test process, and so every child it
// starts with an inherited environment, its own temporary home directory:
// the machine state directory (~/.sannr) and every other home-relative file
// then live there, never in the real home (USE-1 Amendment 4, A17a). A child
// started with an explicit environment that names HOME gets this home too.
// Git's global identity and npm's cache are read from their usual places, so
// tests that commit or pack keep working; nothing is written there.
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MARK = 'TEST_ISOLATED_HOME';
if (!process.env[MARK]) {
  const real = homedir();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'test-home-')));
  const gitConfig = join(real, '.gitconfig');
  if (!process.env.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) process.env.GIT_CONFIG_GLOBAL = gitConfig;
  if (!process.env.npm_config_cache) process.env.npm_config_cache = join(real, '.npm');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env[MARK] = home;
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
}
