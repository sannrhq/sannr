// Imported first by every test file that starts the CLI, the MCP server or a
// packed copy of the package, or calls code that touches machine state (a
// test enforces it: test/test-isolation.test.mjs). It gives the test process,
// and so every child it starts with an inherited environment, its own
// temporary home: HOME and USERPROFILE move there, any inherited SANNR_HOME
// and API_USAGE_LOG are removed so the machine state directory and usage log
// resolve inside it, npm's cache moves there too, and usage counts are off
// (USE-1 Amendment 5, A17b). A child started with an explicit environment
// that names HOME gets this home. Git's global identity is read, never
// written, from its usual place so tests that commit keep working. The
// home is deleted when the process exits.
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME_ENV_NAME, TELEMETRY_ENV_NAME } from '../../lib/brand.mjs';

export const ISOLATED_HOME_MARK = 'TEST_ISOLATED_HOME';
if (process.env[ISOLATED_HOME_MARK] !== String(process.pid)) {
  const real = homedir();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'test-home-')));
  const gitConfig = join(real, '.gitconfig');
  if (!process.env.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env[HOME_ENV_NAME];
  delete process.env.API_USAGE_LOG;
  process.env.npm_config_cache = join(home, '.npm');
  process.env.npm_config_update_notifier = 'false';
  process.env[TELEMETRY_ENV_NAME] = '0';
  process.env.DO_NOT_TRACK = '1';
  process.env[ISOLATED_HOME_MARK] = String(process.pid);
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
}
