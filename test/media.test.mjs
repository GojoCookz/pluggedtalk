import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import pngjs from '../../app/node_modules/pngjs/lib/png.js';
import CrcCalculator from '../../app/node_modules/pngjs/lib/crc.js';
import { digestToCids, cidToBytes32 } from '../../app/src/lib/cid.ts';
import { MediaService, createPinataProvider, mediaErrorResponse, MAX_MEDIA_BYTES } from '../lib/media-service.mjs';
import { normalizeMedia } from '../lib/media-image.mjs';

function image(width = 32, height = 32) {
  return pngjs.PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, 127) });
}
function input(bytes = image(), overrides = {}) {
  return { filename: 'coin.png', contentType: 'image/png', base64: bytes.toString('base64'), ...overrides };
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4, 'ascii'); data.copy(out, 8);
  const crc = new CrcCalculator(); crc.write(out.subarray(4, -4)); out.writeInt32BE(crc.crc32(), out.length - 4);
  return out;
}
function makeProvider(callback = () => {}) {
  return { available: true, async pin(value) {
    callback(value);
    return { cid: digestToCids(`0x${createHash('sha256').update(value.bytes).digest('hex')}`)[0] };
  } };
}
async function rejectsCode(promise, code) {
  try { await promise; throw new Error('Expected rejection'); }
  catch (error) { expect(mediaErrorResponse(error).body.code).toBe(code); }
}

describe('media content boundaries', () => {
  test('real pixels normalize deterministically; filename does not change pinned content', async () => {
    let pinned;
    const service = new MediaService({ provider: makeProvider(value => { pinned = value; }) });
    const first = await service.pin(input());
    const second = await service.pin(input(image(), { filename: 'otra imagen.png' }));
    expect(second).toEqual(first);
    expect(first.width).toBe(32); expect(first.height).toBe(32);
    expect(first.filename).toMatch(/^image-[0-9a-f]{24}\.png$/);
    expect(cidToBytes32(first.cid).digest).toBe(first.digest);
    expect(pngjs.PNG.sync.read(pinned.bytes).data).toEqual(Buffer.alloc(32 * 32 * 4, 127));
  });
  test('known metadata is stripped, not forwarded to provider', () => {
    const original = image(), withHint = Buffer.concat([original.subarray(0, 33), chunk('sRGB', Buffer.from([0])), original.subarray(33)]);
    expect(normalizeMedia(input(withHint)).bytes).toEqual(normalizeMedia(input(original)).bytes);
  });
  test('malformed schemas and remote URL requests never contact provider', async () => {
    let calls = 0;
    const service = new MediaService({ provider: makeProvider(() => calls++) });
    for (const value of [null, [], {}, { url: 'http://169.254.169.254/latest/meta-data/' }, input(image(), { url: 'https://example.com' }), input(image(), { base64: 'AAAA===' }), input(image(), { base64: 'data:image/png;base64,AAAA' }), input(image(), { base64: 'AAAA\nAAA' })]) {
      await rejectsCode(service.pin(value), 'invalid_request');
    }
    expect(calls).toBe(0);
  });
  test('rejects paths, control characters, unsafe filename and MIME spoofing', async () => {
    const service = new MediaService({ provider: makeProvider() });
    for (const filename of ['../coin.png', 'C:\\coin.png', 'a\r\n.png', '\u202eevil.png', 'x.svg', '.png', 'a'.repeat(121) + '.png']) {
      await rejectsCode(service.pin(input(image(), { filename })), 'invalid_filename');
    }
    await rejectsCode(service.pin(input(image(), { contentType: 'image/svg+xml' })), 'unsupported_image');
    await rejectsCode(service.pin(input(Buffer.from('<svg onload="alert(1)"></svg>'))), 'unsupported_image');
    await rejectsCode(service.pin(input(Buffer.from('GIF89a'))), 'unsupported_image');
  });
  test('rejects oversize base64 before decoder/provider and dimensions before inflate', async () => {
    let calls = 0;
    const service = new MediaService({ provider: makeProvider(() => calls++) });
    await rejectsCode(service.pin(input(Buffer.alloc(MAX_MEDIA_BYTES + 1))), 'too_large');
    for (const width of [0, 15, 2049, 0xffffffff]) {
      const original = image(), ihdr = Buffer.from(original.subarray(16, 29)); ihdr.writeUInt32BE(width);
      const bomb = Buffer.concat([original.subarray(0, 8), chunk('IHDR', ihdr), original.subarray(33)]);
      await rejectsCode(service.pin(input(bomb)), 'invalid_dimensions');
    }
    expect(calls).toBe(0);
  });
  test('rejects CRC corruption, truncation, duplicate headers and appended polyglots', async () => {
    const service = new MediaService({ provider: makeProvider() }), original = image();
    const corrupt = Buffer.from(original); corrupt[40] ^= 1;
    for (const bytes of [corrupt, original.subarray(0, -1), original.subarray(0, -12),
      Buffer.concat([original, Buffer.from('<script>alert(1)</script>')]),
      Buffer.concat([original.subarray(0, 33), original.subarray(8, 33), original.subarray(33)]),
      Buffer.concat([original.subarray(0, 33), chunk('tEXt', Buffer.from('comment\0<script>alert(1)</script>')), original.subarray(33)]),
      Buffer.concat([original.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), original.subarray(33)])]) {
      await rejectsCode(service.pin(input(bytes)), 'invalid_image');
    }
  });
  test('rejects deflate bombs, extra zlib streams and invalid pixel filters', async () => {
    const service = new MediaService({ provider: makeProvider() }), original = image();
    const valid = Buffer.alloc((32 * 4 + 1) * 32);
    const invalidFilter = Buffer.from(valid); invalidFilter[0] = 9;
    for (const compressed of [deflateSync(Buffer.alloc(1_000_000)), Buffer.concat([deflateSync(valid), Buffer.from('PK\x03\x04polyglot')]), deflateSync(invalidFilter)]) {
      const bytes = Buffer.concat([original.subarray(0, 33), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
      await rejectsCode(service.pin(input(bytes)), 'invalid_image');
    }
  });
  test('rejects interlaced and palette input before decoder allocation', async () => {
    const original = image(), service = new MediaService({ provider: makeProvider() });
    for (const [index, value] of [[12, 1], [9, 3], [8, 16]]) {
      const ihdr = Buffer.from(original.subarray(16, 29)); ihdr[index] = value;
      await rejectsCode(service.pin(input(Buffer.concat([original.subarray(0, 8), chunk('IHDR', ihdr), original.subarray(33)]))), 'unsupported_image');
    }
  });
});

describe('pinning and credential boundaries', () => {
  test('missing or malformed credential is explicitly unavailable; no fetch', async () => {
    let calls = 0;
    for (const jwt of ['', '  ', 'secret\ninside']) {
      const service = new MediaService({ provider: createPinataProvider({ jwt, fetchImpl: () => { calls++; } }) });
      expect(service.status().available).toBe(false);
      await rejectsCode(service.pin(input()), 'unavailable');
    }
    expect(calls).toBe(0);
  });
  test('provider posts one sanitized PNG with server auth to fixed URL; no redirects', async () => {
    const provider = createPinataProvider({ jwt: ' test-secret ', fetchImpl: async (url, init) => {
      expect(url).toBe('https://api.pinata.cloud/pinning/pinFileToIPFS');
      expect(init.redirect).toBe('error'); expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer test-secret');
      expect(init.body.get('pinataOptions')).toBe('{"cidVersion":1}');
      const file = init.body.get('file');
      expect(file.type).toBe('image/png'); expect(file.name).toMatch(/^image-/);
      const hash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
      return Response.json({ IpfsHash: digestToCids(`0x${hash}`)[0], secret: 'must-not-be-returned' });
    } });
    const service = new MediaService({ provider }), result = await service.pin(input());
    expect(JSON.stringify({ service, status: service.status(), result })).not.toContain('secret');
    expect(result.cid).toMatch(/^bafkrei/);
  });
  test('provider HTTP, malformed JSON, giant replies and exceptions never fake success or leak', async () => {
    for (const [fetchImpl, code] of [
      [async () => new Response('secret', { status: 401 }), 'provider_unavailable'],
      [async () => new Response('secret', { status: 403 }), 'provider_unavailable'],
      [async () => new Response('secret', { status: 429 }), 'provider_unavailable'],
      [async () => new Response('secret', { status: 500 }), 'provider_failure'],
      [async () => new Response('not json secret'), 'provider_failure'],
      [async () => new Response('s'.repeat(16_385)), 'provider_failure'],
      [async () => { throw new Error('Authorization: Bearer secret'); }, 'provider_failure'],
    ]) {
      const service = new MediaService({ provider: createPinataProvider({ jwt: 'secret', fetchImpl }) });
      try { await service.pin(input()); throw new Error('Expected rejection'); }
      catch (error) { const response = mediaErrorResponse(error); expect(response.body.code).toBe(code); expect(JSON.stringify(response)).not.toContain('secret'); }
    }
  });
  test('CID must round-trip exact supported Carbon codec; raw hash must match bytes', async () => {
    const digest = '0x' + '12'.repeat(32), [raw, dagpb] = digestToCids(digest);
    for (const cid of ['', 'https://example.com/ipfs/' + raw, raw, raw + 'a', raw.slice(0, -1) + 'z', 'Qm' + 'a'.repeat(44), digestToCids('0x' + '00'.repeat(32))[0]]) {
      const service = new MediaService({ provider: { available: true, pin: async () => ({ cid }) } });
      await rejectsCode(service.pin(input()), 'provider_failure');
    }
    const service = new MediaService({ provider: { available: true, pin: async () => ({ cid: dagpb }) } });
    expect((await service.pin(input())).digest).toBe(digest);
  });
  test('timeouts and cancellation abort provider; slots recover; max two concurrent pins', async () => {
    let signal;
    const provider = { available: true, pin: async value => { signal = value.signal; return new Promise(() => {}); } };
    const timeoutService = new MediaService({ provider, timeoutMs: 10 });
    await rejectsCode(timeoutService.pin(input()), 'timeout'); expect(signal.aborted).toBe(true);
    const service = new MediaService({ provider, timeoutMs: 1000 }), controller = new AbortController();
    const first = service.pin(input(), { signal: controller.signal }), second = service.pin(input(), { signal: controller.signal });
    await rejectsCode(service.pin(input()), 'busy');
    controller.abort();
    await rejectsCode(first, 'cancelled'); await rejectsCode(second, 'cancelled');
    await rejectsCode(service.pin(input(), { signal: controller.signal }), 'cancelled');
  });
});
