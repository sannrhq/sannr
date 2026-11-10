// OPEN-1: the background process behind `workbench open`. One runs per
// checkout, started detached by lib/workbench-launch.mjs and never by a person.
// It serves the same page and engine handlers as the terminal launch, but a
// page earns its session with a one-use launch grant instead of a typed code,
// and the process answers status, grant and stop on its private control
// endpoint. It ends on stop, 30 minutes after the last request from a page,
// after eight hours, or when another live service holds this checkout's record.
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createWorkbenchServer, WORKBENCH_LIMITS } from './workbench-server.mjs';
import { workbenchAssets, workbenchHandlers, createShowQueue } from './workbench-engine.mjs';
import { createWorkbenchControl } from './workbench-control.mjs';
import { ensureLaunchDirectory, liveWorkbenchService, readServiceRecord, serviceRecordPath } from './workbench-launch.mjs';

const OWNERSHIP_CHECK_MS = 15_000;

// The record appears complete and only if no record is there: written beside
// its final name, then linked into place, which fails when the name exists.
function createExclusive(path, body) {
  const temp = join(dirname(path), `service.tmp-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, body); closeSync(fd); fd = undefined;
    try { linkSync(temp, path); return true; }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      // A filesystem without hard links: create the final name exclusively.
      try { fd = openSync(path, 'wx', 0o600); writeSync(fd, body); return true; }
      catch (fallback) { if (fallback.code === 'EEXIST') return false; throw fallback; }
    }
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* the result stands */ }
    try { unlinkSync(temp); } catch { /* never created */ }
  }
}

/** Run until closed. `notify` reports readiness to the launcher that started this process. */
export async function runWorkbenchService(project, { notify = async () => {}, idleTimeoutMs = WORKBENCH_LIMITS.serviceIdleTimeoutMs } = {}) {
  let server = null, control = null, timer = null, root, instance;
  const mine = () => { const current = readServiceRecord(root); return Boolean(current && !current.invalid && current.instance === instance); };
  // Take this checkout's record, or learn that a live service already has it.
  // A record nothing answers for is replaced; the file is the only thing removed.
  async function claim(record) {
    const path = serviceRecordPath(root), body = `${JSON.stringify(record)}\n`;
    ensureLaunchDirectory(root);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (createExclusive(path, body)) return true;
      if (mine()) return true;
      const other = await liveWorkbenchService(root);
      if (other.state === 'running' || other.state === 'unresponsive') return false;
      try { unlinkSync(path); } catch { /* already replaced */ }
    }
    return false;
  }
  async function shutdown() {
    clearInterval(timer);
    await control?.close();
    if (root && instance && mine()) try { unlinkSync(serviceRecordPath(root)); } catch { /* already gone */ }
  }
  try {
    root = realpathSync.native(resolve(project));
    instance = `wb-${randomUUID()}`;
    const shows = createShowQueue(root);
    server = await createWorkbenchServer({ assets: workbenchAssets({ launch: true }), handlers: workbenchHandlers(root, { sessionId: instance, shows }),
      launch: true, idleTimeoutMs });
    const status = () => ({ instance, root, url: server.url, pid: process.pid, started_at: server.startedAt, expires_at: server.expiresAt, pages: server.pageSessions() });
    control = await createWorkbenchControl({ root, sessionId: instance, onShow: id => shows.push(id), isPaired: () => server.pageSessions() > 0, handlers: {
      status: { run: status },
      // The one place browser authority starts: a grant for the caller's opener.
      grant: { run: () => server.issueLaunchGrant() },
      'grant-status': { fields: ['id'], run: message => ({ state: typeof message.id === 'string' ? server.launchGrantState(message.id) : 'gone' }) },
      stop: { run: () => { setImmediate(() => { void server.close('stopped'); }); return { stopping: true }; } },
    } });
    const record = { version: 1, kind: 'workbench-service', instance, root, pid: process.pid, socket: control.socket, url: server.url, started_at: server.startedAt };
    if (!await claim(record)) {
      await server.close('superseded'); await shutdown();
      await notify({ ok: false, code: 'WORKBENCH_SERVICE_SUPERSEDED' });
      return { reason: 'superseded' };
    }
    // If the record stops naming this process (a deleted evidence folder, or a
    // raced launch), take it back or give way to the live service that holds it.
    let checking = false;
    timer = setInterval(() => {
      if (checking || mine()) return;
      checking = true;
      claim(record).then(held => { if (!held) void server.close('superseded'); }, () => {}).finally(() => { checking = false; });
    }, OWNERSHIP_CHECK_MS);
    timer.unref?.();
  } catch (error) {
    await server?.close('failed'); await shutdown();
    await notify({ ok: false, code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'WORKBENCH_SERVICE_START_FAILED' });
    return { reason: 'failed' };
  }
  const stop = () => { void server.close('signal'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // The launching shell or agent may hang up; the service does not follow it.
  if (process.platform !== 'win32') process.on('SIGHUP', () => {});
  await notify({ ok: true, instance, url: server.url });
  const result = await server.closed;
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  await shutdown();
  return result;
}
