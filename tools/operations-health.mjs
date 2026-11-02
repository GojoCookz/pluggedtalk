import { argumentsFor, cli } from './operations-sqlite.mjs';

export async function checkHealth({ url, timeoutMs = 10000, requireReady = false, fetcher = fetch } = {}) {
  const origin = new URL(url);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) {
    throw new Error('Health URL must be an HTTPS origin or local loopback HTTP origin without credentials.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Timeout must be 100–60000 milliseconds.');
  const results = await Promise.all(['/api/config', '/api/readiness'].map(async path => {
    const start = Date.now();
    try {
      const response = await fetcher(new URL(path, origin), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
      if (!response.ok) return { path, ok: false, status: response.status, milliseconds: Date.now() - start };
      const body = await response.json();
      const ok = path === '/api/config' ? body.network?.id === 4663 : body.chainId === 4663 && typeof body.ready === 'boolean';
      return { path, ok, status: response.status, milliseconds: Date.now() - start,
        ...(path === '/api/readiness' ? { ready: body.ready, blockers: Array.isArray(body.blockers) ? body.blockers.filter(value => typeof value === 'string').map(value => value.slice(0, 120)).slice(0, 30) : [] } : {}) };
    } catch { return { path, ok: false, error: 'Request failed, timed out, redirected, or returned invalid JSON.', milliseconds: Date.now() - start }; }
  }));
  const live = results.every(result => result.ok), ready = live && results[1].ready === true;
  return { ok: live && (!requireReady || ready), live, ready, scope: 'HTTP configuration and catalog readiness only; not DB/RPC/worker health', results };
}
if (import.meta.main) await cli(async () => {
  const args = argumentsFor(process.argv.slice(2), ['--url', '--timeout-ms', '--require-ready']);
  if (args['--require-ready'] && !['true', 'false'].includes(args['--require-ready'])) throw new Error('--require-ready must be true or false.');
  const result = await checkHealth({ url: args['--url'] ?? process.env.PLUGGED_PUBLIC_ORIGIN,
    timeoutMs: Number(args['--timeout-ms'] ?? 10000), requireReady: args['--require-ready'] === 'true' });
  if (!result.ok) process.exitCode = 1;
  return result;
});
