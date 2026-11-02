// Executable source/bundle smoke against an isolated DB and no provider credentials.
// No wallet, RPC request, upload or broadcast is needed for these availability routes.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const temp = await mkdtemp(join(tmpdir(), 'plugged-entry-smoke-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
const results = [];
try {
  for (const entry of ['server.ts', 'server.bundle.js']) {
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = Bun.spawn([process.execPath, '--no-env-file', '--no-install', entry], { cwd: root,
      env: { ...env, PORT: String(port), PLUGGED_DB_PATH: join(temp, entry + '.sqlite'), PLUGGED_LAUNCH_ENABLED: 'false', PLUGGED_PROGRAMS_ENABLED: 'false' }, stdout: 'ignore', stderr: 'pipe' });
    try {
      const base = `http://127.0.0.1:${port}`;
      let health;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`${entry} exited before listening`);
        try { const r = await fetch(base + '/api/health'); if (r.ok) { health = await r.json(); break; } } catch {}
        await Bun.sleep(25);
      }
      assert.equal(health?.scope, 'process-liveness');
      const get = async path => { const r = await fetch(base + path); assert.equal(r.status, 200, path); return r; };
      assert.match(await (await get('/')).text(), /<!doctype html>/i);
      assert.match((await get('/app.js')).headers.get('content-type'), /javascript/);
      assert.equal((await (await get('/api/programs')).json()).status, 'undeployed');
      assert.equal((await (await get('/api/media/status')).json()).available, false);
      const readiness = await (await get('/api/readiness')).json(); assert.equal(readiness.productionReady, false); assert.equal(readiness.features.trading.signingEnabled, false);
      for (const route of ['launches/prepare', 'trading/prepare', 'rewards/prepare', 'programs/prepare']) {
        const r = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 503, route);
      }
      results.push({ entry, http: 'passed', static: 'passed', gates: 'passed', liveProviders: 'not-exercised' });
    } finally {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const code = await child.exited; if (results.at(-1)?.entry === entry) results.at(-1).terminationExitCode = code; }
      finally { clearTimeout(timeout); }
    }
  }
  console.log(JSON.stringify({ ok: true, results, note: 'Isolated availability smoke; no live-provider or contract-readiness claim.' }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
