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
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|api[-_]?key|secret|jwt|access[-_]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 600);
}

export function assertSameOrigin(req, publicOrigin = process.env.PLUGGED_PUBLIC_ORIGIN) {
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

export async function readJson(req, maxBytes = 32000, timeoutMs = 15000) {
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

/** Routes are an explicit allowlist. handlers receive {input, query, req}. */
export function createJsonApi({ routes, resolveRoute, now = Date.now, publicOrigin, maxConcurrent = 12, bodyTimeoutMs = 15000 } = {}) {
  const buckets = new Map();
  let pending = 0;
  return async function handle(req, res, url) {
    const route = routes.get(url.pathname) ?? resolveRoute?.(url.pathname);
    if (!route) return false;
    let entered = false;
    try {
      const method = route.method || 'POST';
      if (req.method !== method) {
        sendJson(res, 405, { error: 'Method not allowed.' }, { allow: method });
        return true;
      }
      if (method !== 'GET') assertSameOrigin(req, publicOrigin);
      const key = route.group || url.pathname;
      let bucket = buckets.get(key);
      if (!bucket || now() - bucket.start >= 60000) { bucket = { start: now(), count: 0 }; buckets.set(key, bucket); }
      if (++bucket.count > (route.limit ?? 60)) {
        sendJson(res, 429, { error: 'Request limit reached. Retry in one minute.' }, { 'retry-after': String(Math.max(1, Math.ceil((bucket.start + 60000 - now()) / 1000))) });
        return true;
      }
      if (pending >= maxConcurrent) {
        sendJson(res, 503, { error: 'Platform is busy. Retry shortly.' }, { 'retry-after': '5' });
        return true;
      }
      pending++; entered = true;
      const input = method === 'GET' ? undefined : await readJson(req, route.maxBytes ?? 32000, bodyTimeoutMs);
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
    } finally { if (entered) pending--; }
    return true;
  };
}
