// Shared request boundary for wallet preparations and credential-backed integrations.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() :
    ['error', 'reason'].includes(key) && typeof item === 'string' ? publicError({ message: item }) : item));
}

export function publicError(error) {
  let message = String(error?.shortMessage || error?.message || 'Unable to complete request.');
  // Provider libraries may echo a header or a bare credential, not just its URL.
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:SECRET|TOKEN|JWT|API_KEY|PRIVATE_KEY|RPC_URL)$/.test(key) && value && value.length >= 8) message = message.split(value).join('[redacted]');
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[provider]')
    // Local filesystem paths (operator profile, home directory) are not public.
    .replace(/(?<=^|[\s"'(=])(?:[A-Za-z]:)?[\\/](?:[^\s"'<>\\/]+[\\/])+[^\s"'<>,;)]*/g, '[path]')
    .replace(/(?<=^|[\s"'(=])(?:file:)\S+/gi, '[path]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|api[-_]?key|secret|jwt|access[-_]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 600);
}

// L5: production must not fall back to the Host-header comparison, which a proxy can let callers choose.
export function assertProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  let origin;
  try { origin = new URL(env.PLUGGED_PUBLIC_ORIGIN ?? ''); } catch { origin = null; }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== env.PLUGGED_PUBLIC_ORIGIN.replace(/\/$/, ''))
    throw new Error('NODE_ENV=production requires PLUGGED_PUBLIC_ORIGIN set to the exact https:// origin (no path).');
}

export function assertSameOrigin(req, publicOrigin = process.env.PLUGGED_PUBLIC_ORIGIN) {
  if (!publicOrigin && process.env.NODE_ENV === 'production') throw new HttpError(503, 'Server origin is not configured.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Use the same-origin platform form.');
  const origin = req.headers.origin;
  if (!origin) return; // Non-browser clients still pass every validation and rate limit.
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    if (publicOrigin) {
      if (parsed.origin !== new URL(publicOrigin).origin) throw new Error();
    } else if (parsed.host !== req.headers.host) throw new Error();
  } catch { throw new HttpError(403, 'Use the same-origin platform form.'); }
}

export async function readJson(req, maxBytes = 32000, timeoutMs = 5000) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Use application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Compressed request bodies are not supported.');
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpError(413, 'Request is too large.');
  const body = await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const finish = (error) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = chunk => { bytes += chunk.length; if (bytes > maxBytes) finish(new HttpError(413, 'Request is too large.')); else chunks.push(Buffer.from(chunk)); };
    const end = () => finish();
    const failed = () => finish(new HttpError(400, 'Request body was interrupted.'));
    const aborted = () => finish(new HttpError(400, 'Request body was interrupted.'));
    const timer = setTimeout(() => finish(new HttpError(408, 'Request body timed out.')), timeoutMs);
    timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
  });
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(422, 'Provide a JSON object.');
  return value;
}

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * Client identity for rate limits. The X-Real-IP header is trusted only when the
 * socket peer is loopback (the local Caddy reverse proxy sets it); a remote peer's
 * header is ignored so clients cannot pick their own bucket.
 */
export function clientKey(req) {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (LOOPBACK.test(peer)) {
    const forwarded = String(req.headers['x-real-ip'] || '').trim();
    if (/^[0-9a-f.:]{2,45}$/i.test(forwarded)) return forwarded.toLowerCase();
  }
  return peer;
}

/** Fixed-window counters with a hard size bound; expired then oldest entries are evicted. */
function createBuckets(now, maxEntries, windowMs = 60000) {
  const map = new Map();
  return function hit(key, limit) {
    const at = now();
    let bucket = map.get(key);
    if (!bucket || at - bucket.start >= windowMs) {
      if (bucket) map.delete(key);
      if (map.size >= maxEntries) {
        for (const [k, b] of map) if (at - b.start >= windowMs) map.delete(k);
        while (map.size >= maxEntries) map.delete(map.keys().next().value);
      }
      bucket = { start: at, count: 0 };
      map.set(key, bucket);
    }
    return ++bucket.count > limit ? Math.max(1, Math.ceil((bucket.start + windowMs - at) / 1000)) : 0;
  };
}

/**
 * Routes are an explicit allowlist. handlers receive {input, query, req}.
 * route.limit is per client per minute; route.globalLimit (default 20x) is the shared backstop.
 * route.dailyLimit adds a per-client 24h cap. route.exempt skips limits and concurrency (liveness probes).
 * Bodies are read and size-checked before a handler slot is taken, so slow uploads
 * cannot starve the handler pool; each client may hold only a few body reads and slots.
 */
export function createJsonApi({ routes, resolveRoute, now = Date.now, publicOrigin, maxConcurrent = 12, maxPerClient = 3,
  maxReadsPerClient = 4, maxReads = 64, bodyTimeoutMs = 5000, maxBuckets = 20000 } = {}) {
  const hitClient = createBuckets(now, maxBuckets);
  const hitGlobal = createBuckets(now, 1000);
  const hitDaily = createBuckets(now, maxBuckets, 86400000);
  const clientPending = new Map();
  const clientReads = new Map();
  let pending = 0, reads = 0;
  const bump = (map, key, delta) => { const n = (map.get(key) || 0) + delta; if (n > 0) map.set(key, n); else map.delete(key); };
  return async function handle(req, res, url) {
    const route = routes.get(url.pathname) ?? resolveRoute?.(url.pathname);
    if (!route) return false;
    let entered = false;
    const client = clientKey(req);
    try {
      const method = route.method || 'POST';
      if (req.method !== method) {
        sendJson(res, 405, { error: 'Method not allowed.' }, { allow: method });
        return true;
      }
      if (method !== 'GET') assertSameOrigin(req, publicOrigin);
      if (route.exempt) {
        const result = await route.handler({ input: undefined, query: url.searchParams, req, res });
        if (!res.destroyed) sendJson(res, 200, result);
        return true;
      }
      const key = route.group || url.pathname;
      const limit = route.limit ?? 60;
      const retry = hitClient(`${client} ${key}`, limit) || hitGlobal(key, route.globalLimit ?? limit * 20)
        || (route.dailyLimit ? hitDaily(` `, route.dailyLimit) : 0);
      if (retry) {
        sendJson(res, 429, { error: retry > 60 ? 'Daily request limit reached. Retry tomorrow.' : 'Request limit reached. Retry in one minute.' }, { 'retry-after': String(retry) });
        return true;
      }
      let input;
      if (method !== 'GET') {
        if (reads >= maxReads || (clientReads.get(client) || 0) >= maxReadsPerClient) throw new HttpError(503, 'Platform is busy. Retry shortly.');
        reads++; bump(clientReads, client, 1);
        try { input = await readJson(req, route.maxBytes ?? 32000, bodyTimeoutMs); }
        finally { reads--; bump(clientReads, client, -1); }
      }
      if (pending >= maxConcurrent || (clientPending.get(client) || 0) >= maxPerClient) {
        sendJson(res, 503, { error: 'Platform is busy. Retry shortly.' }, { 'retry-after': '5' });
        return true;
      }
      pending++; bump(clientPending, client, 1); entered = true;
      const result = await route.handler({ input, query: url.searchParams, req, res });
      if (!res.destroyed) sendJson(res, 200, result);
    } catch (error) {
      if (!req.complete) {
        req.resume();
        // Do not leave a timed-out/oversized chunked upload holding a draining server.
        res.setHeader('connection', 'close');
        res.once('finish', () => req.destroy());
      }
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 422;
      const failure = !(error instanceof HttpError) && route.formatError ? route.formatError(error) : { status, body: { error: publicError(error) } };
      if (!res.headersSent && !res.destroyed) sendJson(res, failure.status, failure.body);
    } finally { if (entered) { pending--; bump(clientPending, client, -1); } }
    return true;
  };
}
