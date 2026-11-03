// Bounded JSON reads from third-party providers: no redirects, capped body size.
export const PROVIDER_FETCH = { redirect: 'error' };

export async function boundedJson(response, maxBytes = 1_000_000) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Provider response is too large.');
  if (!response.body?.getReader) {
    if (typeof response.text !== 'function') return response.json(); // injected test doubles
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('Provider response is too large.');
    return JSON.parse(text);
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('Provider response is too large.'); }
    chunks.push(value);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}
