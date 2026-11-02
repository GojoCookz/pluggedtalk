import { cidToBytes32, ZERO_BYTES32 } from './carbon-helpers.ts';
import { digestToCids } from '../../app/src/lib/cid.ts';
import { normalizeMedia, MAX_MEDIA_BYTES, MIN_MEDIA_DIMENSION, MAX_MEDIA_DIMENSION, MAX_MEDIA_PIXELS } from './media-image.mjs';
import { MediaError, mediaErrorResponse } from './media-errors.mjs';
export { MediaError, mediaErrorResponse } from './media-errors.mjs';
export { MAX_MEDIA_BYTES, MAX_MEDIA_BODY_BYTES } from './media-image.mjs';

const PINATA_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const RESPONSE_LIMIT = 16_384;

export function createPinataProvider({ jwt = process.env.PLUGGED_PINATA_JWT, fetchImpl = globalThis.fetch } = {}) {
  const token = typeof jwt === 'string' ? jwt.trim() : '';
  const available = Boolean(token) && !/[\s\u0000-\u001f\u007f]/.test(token);
  return Object.freeze({
    available,
    async pin({ bytes, filename, contentType, signal }) {
      if (!available) throw new MediaError('unavailable');
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType }), filename);
      form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
      let response;
      try {
        response = await fetchImpl(PINATA_ENDPOINT, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
          redirect: 'error', signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new MediaError([401, 403, 429].includes(response.status) ? 'provider_unavailable' : 'provider_failure');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new MediaError('provider_failure');
        const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > RESPONSE_LIMIT) throw new MediaError('provider_failure');
            chunks.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return { cid: body?.IpfsHash };
      } catch (error) {
        if (error instanceof MediaError) throw error;
        // Includes fetch header errors containing credentials and malformed provider JSON.
        throw new MediaError('provider_failure');
      }
    },
  });
}

export class MediaService {
  #provider;
  #active = 0;
  #timeoutMs;
  constructor({ provider = createPinataProvider(), timeoutMs = 45_000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid media timeout');
    this.#provider = provider;
    this.#timeoutMs = timeoutMs;
  }
  status() {
    return {
      available: this.#provider.available === true, provider: 'pinata', acceptedTypes: ['image/png'],
      maxBytes: MAX_MEDIA_BYTES, minDimension: MIN_MEDIA_DIMENSION, maxDimension: MAX_MEDIA_DIMENSION, maxPixels: MAX_MEDIA_PIXELS,
      ...(this.#provider.available === true ? {} : { reason: 'Image uploads are unavailable. Paste an existing image CID instead.' }),
    };
  }
  async pin(input, { signal } = {}) {
    if (!this.status().available) throw new MediaError('unavailable');
    if (signal?.aborted) throw new MediaError('cancelled');
    if (this.#active >= 2) throw new MediaError('busy');
    this.#active++;
    const controller = new AbortController();
    let timer, rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = code => { controller.abort(); rejectAbort(new MediaError(code)); };
    const cancel = () => stop('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const image = normalizeMedia(input);
      timer = setTimeout(() => stop('timeout'), this.#timeoutMs);
      const result = await Promise.race([
        Promise.resolve().then(() => this.#provider.pin({ ...image, signal: controller.signal })), interrupted,
      ]);
      if (signal?.aborted) throw new MediaError('cancelled');
      const cid = result?.cid;
      // Carbon decodes permissively. Require exact round-trip to its supported codecs
      // as well, excluding trailing bytes, alternate padding, zero digest and URLs.
      if (typeof cid !== 'string' || cid.length !== 59 || !/^b[a-z2-7]{58}$/.test(cid)) throw new MediaError('provider_failure');
      const decoded = cidToBytes32(cid);
      if (!decoded.ok || decoded.digest === ZERO_BYTES32 || !digestToCids(decoded.digest).includes(cid)) throw new MediaError('provider_failure');
      if (cid.startsWith('bafkrei') && decoded.digest !== `0x${image.sha256}`) throw new MediaError('provider_failure');
      return { cid, digest: decoded.digest, filename: image.filename, contentType: image.contentType,
        bytes: image.bytes.length, width: image.width, height: image.height };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('provider_failure');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.#active--;
    }
  }
}
