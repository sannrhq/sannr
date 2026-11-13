// Every test file that starts the CLI, the MCP server or a packed copy of the
// package, or imports code that reads or writes machine state, imports
// test/helpers/isolated-home.mjs before anything else, so no test, run by the
// suite or directly, can write to an inherited home or state directory
// (USE-1 Amendment 5, A17b). The patterns below are what such a file
// contains; a file that matches and does not import the helper first fails.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
// Starting a product process, or packing one.
export const STARTS = /bin\/cli\.mjs|bin\/request(?:-main)?\.mjs|['"`/]server\.mjs|stdio-server|bin\/map-preview|packedCli|PACKED|stagePackage|['"]pack['"]|['"]--pack-destination['"]/;
// Importing code that reads or writes machine state (~/.sannr, the usage log,
// tokens, the registry, telemetry) or runs requests through the client.
export const MACHINE_STATE = /from ['"]\.\.\/lib\/(?:client|registry|machine-state|connect|telemetry|feedback-send|feedback|protocol-client|saved-request-actions|saved-request-cli|account-facts|session-ledger|session-summary|receipt|doctor-observation|map-execution|workbench[\w/-]*|librarian|graph-record|agent-graph-context|context|operation-context|note-review-actions|key-sources|suites|verify|onboarding|map)\.mjs['"]/;
export function needsIsolation(source) { return STARTS.test(source) || MACHINE_STATE.test(source); }
export function importsHelperFirst(source) {
  const first = /^import\s[^;\n]*?['"]([^'"]+)['"]/m.exec(source);
  return first?.[1] === './helpers/isolated-home.mjs';
}

test('A17b: every test file that starts the product or touches machine state imports the isolated home first', () => {
  const missing = [];
  for (const name of readdirSync(TEST_DIR).filter(name => name.endsWith('.test.mjs') || ['truthful.mjs', 'stress.mjs'].includes(name))) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8');
    if (needsIsolation(source) && !importsHelperFirst(source)) missing.push(name);
  }
  assert.deepEqual(missing, [], `import './helpers/isolated-home.mjs' first in: ${missing.join(', ')}`);
});

test('A17b: the helper itself moves the home, the state directory, the usage log and npm cache, and turns counting off', async () => {
  const { HOME_ENV_NAME, TELEMETRY_ENV_NAME } = await import('../lib/brand.mjs');
  assert.match(process.env.HOME, /test-home-/);
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(process.env[HOME_ENV_NAME], undefined);
  assert.equal(process.env.API_USAGE_LOG, undefined);
  assert.ok(process.env.npm_config_cache.startsWith(process.env.HOME));
  assert.equal(process.env[TELEMETRY_ENV_NAME], '0');
});
