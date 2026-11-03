import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { usdValuation, quoteEthRoute, routeInput } from './lib/market-services.mjs';
import { resolveSocial, resolveLaunchRecipients, integrationReadiness } from './lib/social-service.mjs';
import { validatePlan } from './lib/plan.mjs';
import { NETWORK, POLICY, QUOTES } from './lib/config.mjs';
import { LOCALE_CODES } from './lib/locales.mjs';
import assetCatalog from './data/assets.json';
import ponsReference from './data/pons-reference.json';
import carbonDeployment from './data/carbon-deployment.json';
import carbonPairs from './data/carbon-pairs.json';
import { LaunchStore } from './lib/launch-store.mjs';
import { LaunchService } from './lib/launch-service.mjs';
import { AdvancedLaunchService } from './lib/advanced-launch-service.mjs';
import { prepareFunding } from './lib/funding-service.mjs';
import { TradingService } from './lib/trading-service.mjs';
import { AdvancedMarketService } from './lib/advanced-market-service.mjs';
import { AdvancedTradingService } from './lib/advanced-trading-service.mjs';
import { AdvancedRewardsService } from './lib/advanced-rewards-service.mjs';
import { RewardsService } from './lib/rewards-service.mjs';
import { FeeVaultService, feeVaultManifestFromEnv } from './lib/fee-vault-service.mjs';
import { ProgramService } from './lib/program-service.mjs';
import { ProgramStore } from './lib/program-service-store.mjs';
import { MediaService, MAX_MEDIA_BODY_BYTES, mediaErrorResponse } from './lib/media-service.mjs';
import { assertProductionConfig, createJsonApi, HttpError, sendJson as json } from './lib/http-api.mjs';

const files = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/mark.svg', ['mark.svg', 'image/svg+xml']], ...LOCALE_CODES.filter(code => code !== 'en').map(code => [`/locales/${code}.js`, [`locales/${code}.js`, 'text/javascript']])]);
const dist = new URL('./dist/', import.meta.url);

/** Injection is server-side only. No HTTP input selects a service, provider or deployment. */
export function createPlatformServer(options: any = {}) {
  const dbPath = options.dbPath ?? (process.env.PLUGGED_DB_PATH || fileURLToPath(new URL('./runtime/launches.sqlite', import.meta.url)));
  const launchEnabled = options.launchEnabled ?? process.env.PLUGGED_LAUNCH_ENABLED === 'true';
  const programsEnabled = options.programsEnabled ?? process.env.PLUGGED_PROGRAMS_ENABLED === 'true';
  let launchService = options.launchService;
  let trading = options.tradingService, rewards = options.rewardsService, programs = options.programService;
  const media = options.mediaService ?? new MediaService();
  const launches = () => launchService ??= new LaunchService({ store: new LaunchStore(dbPath) });
  let advancedService = options.advancedService;
  const advanced = () => advancedService ??= new AdvancedLaunchService({ store: launches().store, client: launches().client,
    profilePath: options.advancedProfilePath ?? (process.env.PLUGGED_ADVANCED_PROFILE || null) });
  let advancedMarketService = options.advancedMarketService, advancedTrading = options.advancedTradingService, advancedRewards = options.advancedRewardsService;
  const advancedMarkets = () => advancedMarketService ??= new AdvancedMarketService({ advancedService: advanced() });
  const advancedTrades = () => advancedTrading ??= new AdvancedTradingService({ launchService: launches(), marketService: advancedMarkets() });
  const advancedEarnings = () => advancedRewards ??= new AdvancedRewardsService({ marketService: advancedMarkets() });
  const trades = () => trading ??= new TradingService({ launchService: launches() });
  const earnings = () => rewards ??= new RewardsService({ launchService: launches(), splitters: options.splitters ?? [] });
  // Fails closed: no verified manifest means status-only responses and 503 on actions.
  const feeVault = options.feeVaultService ?? new FeeVaultService({ client: () => launches().client, manifest: options.feeVault ?? feeVaultManifestFromEnv(),
    symbols: Object.fromEntries(QUOTES.map((q: any) => [q.address.toLowerCase(), q.symbol])) });
  // All default services share one SQLite handle. An explicit separate program path
  // is supported for existing operators and needs its own backup policy.
  const programService = () => programs ??= new ProgramService({ launchService: launches(), enabled: programsEnabled,
    manifest: options.programManifest, voucherProvider: options.voucherProvider,
    store: new ProgramStore(options.programDbPath ?? (process.env.PLUGGED_PROGRAMS_DB_PATH || launches().store.db)) });
  // A configured manifest must fail startup, rather than silently producing an empty UI.
  if (process.env.PLUGGED_PROGRAMS_MANIFEST || options.programManifest) programService();
  const startedAt = new Date().toISOString();
  let draining = false, worker: ReturnType<typeof setInterval> | undefined;
  let reconciliation: Promise<void> | undefined, shutdownPromise: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const workerState = { running: false, lastCompletedAt: null as string | null, lastFailedAt: null as string | null };
  const gate = (enabled: boolean, label: string) => { if (!enabled) throw new HttpError(503, `${label} signing is disabled by the operator.`); };
  const id = (input: any) => { if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) throw new HttpError(422, 'Invalid preparation ID.'); return input.id; };
  const exact = (input: any, keys: string[]) => { if (Object.keys(input).some(key => !keys.includes(key))) throw new HttpError(422, 'Unsupported request fields.'); };
  const routes = new Map<string, any>();
  const get = (path: string, handler: any, extra = {}) => routes.set(path, { method: 'GET', handler, ...extra });
  const post = (path: string, handler: any, extra = {}) => routes.set(path, { handler, ...extra });

  get('/api/health', () => ({ status: draining ? 'draining' : 'ok', service: 'plugged', startedAt, chainId: NETWORK.id,
    scope: 'process-liveness', note: 'This endpoint does not assert deployment or provider readiness.' }), { exempt: true });
  get('/api/config', () => ({ network: { ...NETWORK, launcher: carbonDeployment.deployment.launcher }, policy: POLICY, quotes: QUOTES,
    launchEnabled, programsEnabled, engine: carbonDeployment, reason: launchEnabled ? null : 'Launch signing is disabled by the operator.' }));
  get('/api/assets', () => assetCatalog);
  get('/api/engine/pairs', () => carbonPairs);
  get('/api/readiness', () => ({ ready: launchEnabled && carbonPairs.coverage.pendingApproval === 0 && carbonPairs.coverage.failed === 0,
    launchEnabled, scope: 'carbon-launch-mvp', openingMarketCapUsd: '2500', inputCurrency: 'ETH', chainId: 4663,
    blockers: [...(!launchEnabled ? ['PLUGGED_LAUNCH_ENABLED'] : []), ...(carbonPairs.coverage.pendingApproval ? ['PAIR_REGISTRY_OWNER_APPROVALS'] : []), ...(carbonPairs.coverage.failed ? ['PAIR_VERIFICATION_FAILURES'] : [])],
    pairs: { ...carbonPairs.coverage, owner: carbonPairs.owner, checkedAt: carbonPairs.checkedAt },
    pairApproval: 'Snapshot only. Each preparation rechecks the selected pair on-chain.', postMvp: integrationReadiness(),
    availability: { http: true, draining, worker: { ...workerState }, database: launchService ? 'opened' : 'not-opened' },
    features: {
      trading: { implemented: true, signingEnabled: launchEnabled, verification: 'per-request', onchainDeadline: false },
      rewards: { implemented: true, signingEnabled: launchEnabled, verification: 'per-request', splittersConfigured: options.splitters?.length ?? 0 },
      programs: { implemented: true, signingEnabled: programsEnabled, deploymentsConfigured: programs?.manifest?.length ?? 0, verification: 'per-request', attestorConfigured: Boolean(options.voucherProvider) },
      media: { ...media.status(), scope: 'configuration-only', providerHealth: 'unverified' },
      deployment: { runtime: 'pinned-carbon-baseline', independentProfileActivation: false },
      advanced: { implemented: true, engine: 'plugged-advanced-v1', profileConfigured: Boolean(options.advancedProfilePath ?? process.env.PLUGGED_ADVANCED_PROFILE), signingEnabled: launchEnabled, verification: 'per-request', status: '/api/advanced/config',
        markets: '/api/advanced/markets', trading: 'per-pool', rewards: ['sweep', 'release', 'recover-splitter', 'recover-feed'], holderLedgerClaims: false },
    }, productionReady: false, note: 'HTTP availability, operator flags and catalog snapshots do not establish live provider, deployment, hosting or backup readiness.' }));
  get('/api/pons-reference', () => ({ ...ponsReference, native: ponsReference.liveConfiguration.nativeQuote, assets: ponsReference.approvedAssets }));
  get('/api/markets', async () => { try { return await launches().markets(); } catch { throw new HttpError(503, 'Robinhood market source is unavailable. Retry shortly.'); } }, { limit: 30 });
  get('/api/valuation', async ({ query }: any) => { try { return await (options.usdValuation ?? usdValuation)(query.get('quote'), query.get('milestoneUsd') ?? undefined); } catch { throw new HttpError(503, 'USD conversion unavailable. The $2,500 target is unchanged; retry pricing.'); } });
  post('/api/launches/prepare', ({ input }: any) => { gate(launchEnabled, 'Launch'); return launches().prepare(input); });
  post('/api/launches/funding', ({ input }: any) => { gate(launchEnabled, 'Launch'); return (options.prepareFunding ?? prepareFunding)(input); });
  post('/api/launches/submit', ({ input }: any) => { exact(input, ['id', 'txHash']); return launches().submit(id(input), input.txHash); });
  post('/api/launches/status', ({ input }: any) => {
    exact(input, ['id']); const record = launches().store.get(id(input));
    if (!record || record.engine) throw new HttpError(404, 'Preparation not found.');
    return record.txHash ? launches().confirm(record) : launches().view(record);
  });
  // Advanced engine: fails closed unless a verified plugged-advanced-v1 profile is configured.
  // Preparation follows the same operator signing gate; submit/status recovery stays available.
  get('/api/advanced/config', () => advanced().status());
  post('/api/advanced/prepare', ({ input }: any) => { gate(launchEnabled, 'Launch'); return advanced().prepare(input); });
  post('/api/advanced/submit', ({ input }: any) => { exact(input, ['id', 'txHash']); return advanced().submit(id(input), input.txHash); });
  post('/api/advanced/status', ({ input }: any) => { exact(input, ['id']); return advanced().recordStatus(id(input)); });
  // Advanced markets: listed, traded and rewarded only after per-request re-verification.
  get('/api/advanced/markets', () => advancedMarkets().list(), { limit: 30 });
  get('/api/advanced/token', ({ query }: any) => advancedMarkets().detail(query.get('address') ?? ''), { limit: 30 });
  post('/api/advanced/trading/balances', ({ input }: any) => advancedTrades().balances(input));
  post('/api/advanced/trading/quote', ({ input }: any) => advancedTrades().quote(input));
  post('/api/advanced/trading/prepare', ({ input }: any) => { gate(launchEnabled, 'Trading'); return advancedTrades().prepare(input); });
  post('/api/advanced/trading/submit', ({ input }: any) => advancedTrades().submit(input));
  post('/api/advanced/trading/status', ({ input }: any) => advancedTrades().status(input));
  post('/api/advanced/rewards/positions', ({ input }: any) => advancedEarnings().positions(input), { limit: 10 });
  post('/api/advanced/rewards/prepare', ({ input }: any) => { gate(launchEnabled, 'Rewards'); return advancedEarnings().prepare(input); });
  post('/api/advanced/rewards/submit', ({ input }: any) => advancedEarnings().submit(input));
  post('/api/trading/balances', ({ input }: any) => trades().balances(input));
  post('/api/trading/quote', ({ input }: any) => trades().quote(input));
  post('/api/trading/prepare', ({ input }: any) => { gate(launchEnabled, 'Trading'); return trades().prepare(input); });
  post('/api/trading/submit', ({ input }: any) => trades().submit(input));
  post('/api/trading/status', ({ input }: any) => trades().status(input));
  post('/api/rewards/positions', ({ input }: any) => earnings().positions(input), { limit: 10 });
  post('/api/rewards/prepare', ({ input }: any) => { gate(launchEnabled, 'Rewards'); return earnings().prepare(input); });
  post('/api/rewards/submit', ({ input }: any) => earnings().submit(input));
  post('/api/rewards/status', ({ input }: any) => earnings().submit(input));
  get('/api/vault/status', () => feeVault.status());
  post('/api/vault/containers', ({ input }: any) => feeVault.containers(input), { limit: 20 });
  post('/api/vault/prepare', ({ input }: any) => { gate(launchEnabled, 'Vault'); return feeVault.prepare(input); });
  post('/api/vault/submit', ({ input }: any) => feeVault.submit(input));
  get('/api/programs', ({ query }: any) => programService().list({ account: query.get('account') || undefined }));
  post('/api/programs/prepare', ({ input }: any) => { gate(programsEnabled, 'Program'); return programService().prepare(input); });
  post('/api/programs/submit', ({ input }: any) => { exact(input, ['id', 'txHash']); return programService().submit(input.id, input.txHash); });
  post('/api/programs/status', ({ input }: any) => { exact(input, ['id']); return programService().status(input.id); });
  post('/api/programs/voucher', ({ input }: any) => { gate(programsEnabled, 'Program'); return programService().voucher(input); }, { limit: 10 });
  get('/api/media/status', () => media.status());
  post('/api/media/pin', async ({ input, req, res }: any) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    req.once('aborted', cancel);
    req.socket.once('close', cancel);
    try { if (res.destroyed) controller.abort(); return await media.pin(input, { signal: controller.signal }); }
    finally { res.off('close', cancel); req.off('aborted', cancel); req.socket.off('close', cancel); }
  }, { maxBytes: MAX_MEDIA_BODY_BYTES, limit: 5, globalLimit: 30, dailyLimit: 30, formatError: mediaErrorResponse });
  post('/api/recipients/resolve', ({ input }: any) => {
    if (!options.resolveSocial && !process.env.BAGS_API_KEY) throw new HttpError(503, 'Social wallet resolution is not configured. You can save the profile allocation now.');
    return (options.resolveSocial ?? resolveSocial)(input);
  }, { limit: 10 });
  post('/api/routes/quote', async ({ input }: any) => {
    routeInput(input);
    try { return await (options.quoteEthRoute ?? quoteEthRoute)(input); } catch { throw new HttpError(503, 'No current ETH route. Retry or select another quote asset.'); }
  });
  const plan = ({ input }: any, prepare = false) => {
    const result = validatePlan(input);
    if (!result.ok) throw Object.assign(new Error('Invalid plan.'), { status: 422, validation: result });
    return prepare ? { ...integrationReadiness(), plan: result.value, recipients: resolveLaunchRecipients(result.value) } : result;
  };
  const planError = (error: any) => ({ status: 422, body: error.validation ?? { error: 'Unable to prepare this plan. Resolve recipients first.' } });
  post('/api/plans/validate', (ctx: any) => plan(ctx), { formatError: planError });
  post('/api/plans/prepare', (ctx: any) => plan(ctx, true), { formatError: planError });
  const api = createJsonApi({ routes, publicOrigin: options.publicOrigin, now: options.now, bodyTimeoutMs: options.bodyTimeoutMs,
    resolveRoute: (path: string) => {
      const match = /^\/api\/programs\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
      return match ? { method: 'GET', group: 'program-details', handler: ({ query }: any) => programService().details(match[1], { account: query.get('account') || undefined }) } : undefined;
    } });
  const handle = async (req: any, res: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://dexscreener.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // Bun 1.3.9 IncomingMessage._destroy clears the native response's onabort
      // when the request body ends. Retain it until the media response finishes so
      // disconnects can cancel provider work. Covered by a real TCP disconnect test.
      if (url.pathname === '/api/media/pin' && typeof Bun !== 'undefined' && Bun.version === '1.3.9' && req._readableState) {
        req._readableState.autoDestroy = false;
        res.once('finish', () => req.destroy());
      }
      if (draining && url.pathname !== '/api/health') return json(res, 503, { error: 'Server is draining. Retry shortly.' }, { connection: 'close' });
      if (await api(req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      const file = files.get(url.pathname);
      if (!file) return json(res, 404, { error: 'Not found.' });
      const body = await readFile(new URL(file[0], dist));
      res.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8`, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { if (!res.headersSent && !res.destroyed) json(res, 500, { error: 'Unable to complete request.' }); }
  };
  const server = createServer((req, res) => { const request = handle(req, res); active.add(request); void request.finally(() => active.delete(request)); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  function reconcile() {
    if (draining || reconciliation) return reconciliation ?? Promise.resolve();
    workerState.running = true;
    reconciliation = (async () => {
      try {
        let failed = false;
        // Do not use feature loggers that may include credential-bearing RPC errors.
        // Continue other retained records even when one upstream lookup fails.
        for (const [service, limit] of [[launches(), 20], [programService(), 100]] as const) {
          const store: any = service.store;
          for (const record of store.listForReconcile ? store.listForReconcile('submitted', limit) : store.list('submitted', limit)) {
            try { await service.confirm(record); } catch { failed = true; }
            try { store.checked?.(record.id, Date.now()); } catch {}
          }
        }
        if (!(await advanced().reconcile())) failed = true;
        if (failed) throw new Error('Reconciliation incomplete');
        workerState.lastCompletedAt = new Date().toISOString();
      }
      catch { workerState.lastFailedAt = new Date().toISOString(); console.error('Platform reconciliation failed; retained submissions will be retried.'); }
      finally { workerState.running = false; reconciliation = undefined; }
    })();
    return reconciliation;
  }
  function startWorker() { if (!worker && !draining) { worker = setInterval(() => void reconcile(), 15000); worker.unref(); } }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    draining = true; clearInterval(worker);
    shutdownPromise = (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      await closed; await Promise.allSettled([...active]); await reconciliation;
      programs?.close(); launchService?.store.close();
    })();
    return shutdownPromise;
  }
  return { server, reconcile, startWorker, shutdown, services: { launches, trades, earnings, programs: programService, media, feeVault } };
}

const platform = createPlatformServer();
export const server = platform.server;
if (import.meta.main) {
  try { assertProductionConfig(); } catch (error: any) { console.error(error.message); process.exit(1); }
  const port = Number(process.env.PORT || 4317);
  server.listen(port, '127.0.0.1', () => console.log(`Plugged frozen build: http://localhost:${port}\nAssets: ${fileURLToPath(dist)}`));
  platform.startWorker();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { console.error('Shutdown deadline exceeded; persisted submissions will reconcile on restart.'); process.exit(1); }, 30000);
    platform.shutdown().then(() => clearTimeout(deadline), () => { console.error('Shutdown failed.'); process.exit(1); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
