# Media upload workstream

## Integration contract (implemented; parent wiring required)

Owned files: `lib/media*.mjs`, `web/media.js`, `test/media*`, this document. No shared-file edits or paid uploads.

- Server credential: **`PLUGGED_PINATA_JWT`**, server environment only. No browser/public prefix, no fallback to Carbon credentials.
- `GET /api/media/status`: `media.status()` → `{available, provider:"pinata", acceptedTypes:["image/png"], maxBytes:2097152, minDimension:16, maxDimension:2048, maxPixels:4194304}`. Missing key reports `available:false` and a safe reason. This reports configuration, not live provider health.
- `POST /api/media/pin`, `Content-Type: application/json`: `{filename:"coin.png", contentType:"image/png", base64:"<canonical padded base64, no data URL>"}`. Only these three keys. **PNG only**, 2 MiB encoded-file limit, 16–2048 px on both axes, at most 4,194,304 pixels. Noninterlaced 8-bit RGB/RGBA PNG; export other images as PNG first.
- Stream JSON body with **`MAX_MEDIA_BODY_BYTES`** cap before parsing (2,800,000 bytes). Do not reuse the 32 KB launch cap. Reject non-JSON/content encoding; enforce same-origin, rate limit and request-body timeout before decoding. Forward client disconnect via `AbortSignal`.
- `await media.pin(input,{signal})` → `{cid,digest,filename,contentType:"image/png",bytes,width,height}`. `bytes` describes sanitized pinned bytes. Metadata is stripped; returned filename is generated from content, never a path supplied by the user. CID comes only from successful provider response, validated against Carbon's codec.
- Errors: catch using `mediaErrorResponse(error)` → `{status,body:{error,code}}`. This is the only safe public error formatter. Never expose provider exception messages/bodies or serialize the service/client.
- Backend exports: `MediaService`, `createPinataProvider`, `mediaErrorResponse`, constants from `lib/media-service.mjs`.
- Browser: `mediaUploader({language,esc,onPinned})` → `{mount(root),destroy()}`. `language` returns `en`/`es`; `onPinned(result)` receives the object above. Parent sets the existing `imageCid` input and dispatches its bubbling `input` event (persist/invalidate review). Keep manual CID entry available in every upload state. Destroy before route/language remount; never rerender upload root during ordinary form updates.
- Parent owns importing module into `launch.js`, routing `server.ts`, `.env.example`, styles, build and portable exporter. Bundle the existing PNG decoder (`app/node_modules/pngjs`, MIT, installed 5.0.0) server-side only. No new install required; portable source package needs that dependency available or bundled.

### Exact server wiring

```js
import { MediaService, MAX_MEDIA_BODY_BYTES, mediaErrorResponse } from './lib/media-service.mjs';
const media = new MediaService(); // One instance per server, not one per request.

// GET /api/media/status
return json(res, 200, media.status());

// POST /api/media/pin, after the HTTP guards and bounded JSON reader:
const controller = new AbortController();
res.on('close', () => { if (!res.writableEnded) controller.abort(); });
try {
  const result = await media.pin(input, { signal: controller.signal });
  if (!res.destroyed) return json(res, 200, result);
} catch (error) {
  const failure = mediaErrorResponse(error);
  if (!res.destroyed) return json(res, failure.status, failure.body);
}
```

Register these routes before the ordinary 32 KB launch-body reader. Apply an upload-specific request limit **before reading the body**, reject oversized Content-Length and streamed bodies, and accept only JSON with no content encoding. Origin validation should use the trusted public origin/host configuration, not an arbitrary client-supplied forwarding header. No CORS wildcard. The service caps concurrent provider operations at two and cancels after 45 seconds; browser transport times out at 60 seconds. Keep the existing finite request-body timeout; a provider timeout is a separate phase. No route accepts a URL or user-selected provider/gateway endpoint.

Configuration is deliberately only:

```dotenv
# Server only. Pinata JWT with file-pinning permission; leave blank to disable uploads.
PLUGGED_PINATA_JWT=
```

The service does not use `PINATA_JWT`, `VITE_*` or a client config object. `status()` is an explicit allowlist and does not serialize credentials. Missing or malformed keys return 503/code `unavailable`. Bad provider authorization/quota returns 503/`provider_unavailable`; provider rejection, invalid JSON/CID, response over 16 KiB or network errors return 502/`provider_failure`; timeout 504/`timeout`; client cancellation 499/`cancelled`; saturation 429/`busy`. Validation errors are 400/`invalid_request` or `invalid_filename`, 413/`too_large`, 415/`unsupported_image`, and 422/`invalid_image` or `invalid_dimensions`. Provider bodies and exception messages are never logged or returned by this module.

### Exact browser wiring

```js
import { mediaUploader } from './media.js';
const uploader = mediaUploader({ language, esc, onPinned(result) {
  const field = document.querySelector('#live-form [name=imageCid]');
  if (!field) return;
  field.value = result.cid;
  field.dispatchEvent(new Event('input', { bubbles: true }));
} });
// Add <div id="launch-media" class="full"></div> beside the existing imageCid field.
uploader.mount(document.querySelector('#launch-media'));
// Before route/language remount, or when leaving creation:
uploader.destroy();
```

The current `launchScreen.update()` disables/enables every button and input under `#live-launch`; **exclude `.media-uploader` descendants from that sweep** so it cannot re-enable unavailable upload controls or disable cancellation. If launch signing should disable the whole uploader, destroy/remount it at those boundaries or put its host in a disabled fieldset under parent control; do not override its individual states. A pending upload must not overwrite a manually edited CID: parent should destroy the uploader on a manual `imageCid` edit (and remount if desired), or compare the CID field revision in the callback. Do not destroy it for its own successful CID callback. Always preserve the existing externally supplied CID on selection, upload failure, cancellation or clearing the preview.

Preview uses a local `data:image/png` URL, already permitted by the current CSP. No `blob:` or arbitrary remote image permissions are required. The component reuses `.field`, `.full`, `.form-actions`, `.primary`, `.receipt-note`, `.error-list` and global focus rules. It contains no inline styles, injected styles, new font or animation library. Native file-dialog language follows the browser/OS; component copy follows `language()`.

### Provider and validation details

The provider reuses Carbon's fixed Pinata endpoint and multipart `cidVersion:1` approach, not Carbon's permissive MIME-only handler. Full pixel decode/re-encode uses installed `pngjs` 5.0.0 and native zlib. A restrictive envelope guard handles that version's ignored trailing data and unbounded interlaced inflate path before decoding: bounded chunks, CRC on every accepted chunk, exactly one IHDR, one terminal IEND, exact bounded decompressed row length and no data after zlib EOF. Only RGB/RGBA 8-bit noninterlaced PNG and fixed-size sRGB/gAMA/pHYs hints are accepted. APNG, palettes, SVG, GIF, JPEG, WebP, EXIF, text chunks, unknown chunks, duplicate headers and appended polyglots are rejected. Valid color/resolution hints are stripped on re-encoding. Export a fresh PNG for unsupported input.

Pinned bytes use fixed RGBA encoding, independent of user filename. Generated filename is `image-<24 SHA-256 hex characters>.png`. Filename input is bounded to 120 characters and rejects paths, controls and bidi control characters. Successful CIDs must be canonical CIDv1 sha2-256, either raw or dag-pb, round-tripping exactly through the current Carbon `cidToBytes32` and `digestToCids`. Raw CID digest is additionally checked against sanitized bytes; dag-pb content addressing is attested by the provider because its UnixFS root is not the raw file hash. No fake placeholder CID is returned and no gateway is fetched. Carbon's existing manual CID path continues to accept its own supported encodings independently.

For injection tests use `new MediaService({provider:{available:true,pin:async ({bytes,filename,contentType,signal})=>({cid})}})`. `createPinataProvider({jwt,fetchImpl})` tests the actual multipart transport without a network call. `timeoutMs` can be injected in the range 1–60000 ms.

For the portable source exporter, include `pngjs` 5.0.0 and its MIT license, or preserve the already bundled backend. The module imports `../../app/node_modules/pngjs/lib/png.js`, `lib/crc.js`, the existing Carbon helper, and `../../app/src/lib/cid.ts`. The existing three Carbon helper files already include the latter codec. Do not copy a populated `.env` or JWT into the archive. A standalone Bun media-service bundle was verified: **28 modules, 76.65 KB**; no package installation was performed.

## UX plan

Operate mode: preserve Plugged's existing `.field`, `.primary`, `.receipt-note`, `.error-list` styles and system typography. Single-column mobile uploader: labeled native PNG picker → local preview/size → explicit **Upload image** action. Actual byte-transfer progress followed by indeterminate provider pinning. Cancel stops local transport; no false promise of deleting a pin already accepted upstream. Status and errors are live regions in EN/ES. Uploaded image fills the CID through the parent callback, not a second source of launch state.

## Verification and blockers

- `bun test plugged/test/media.test.mjs`: **13 passing tests, 89 assertions, zero failures**. Tests cover malformed schema/base64, remote-fetch rejection, filenames/MIME spoofing, input size and dimensions, CRC/truncation/polyglots, duplicate headers, APNG/interlace/palette rejection, deflate bombs/trailing compressed payloads, normalization determinism, credential absence/leakage, fixed provider URL/options, provider HTTP/JSON/size/network failures, Carbon CID canonicalization/raw digest binding, timeouts, cancellation and concurrency.
- `node plugged/test/media-browser.mjs` (Node 24.21.0): **40 passing checks**, **eight viewport/theme/language states × 94 AccessLint rules**, **zero violations, zero skipped rules, zero browser runtime errors**. This is automated fixture verification, not a live provider claim or full WCAG certification. The fixture uses the actual media service with an injected provider and the actual browser module/styles. It tests keyboard upload, callback/CID integration, duplicate-submit prevention, clear-selection preservation, provider failure, indeterminate pinning, cancellation/retry, invalid file, Spanish unavailable fallback/recheck and teardown/stale-result prevention.
- Visual loop: mobile 390×844 first, then desktop 1440×1000. Corrected native picker losing the selected filename, desktop label alignment, unnecessary empty-state spacing and Spanish decimal formatting; recaptured and inspected all three final screenshots. Evidence: `C:/Users/shies/AppData/Local/Temp/opencode/plugged-media/` (`media-mobile.png`, `media-desktop.png`, `media-unavailable-es.png`, `media-browser.json`). Fixture artwork is a generated test image, visibly labeled simulated; it is not shipped product artwork.
- Mechanical design detector reported one intentional false positive: the preview `<img>` starts with no `src` **and hidden** until a selected PNG successfully decodes. No broken image is rendered. Web-interface review informed native labels, names/autocomplete, localized byte formatting and cancellation controls.
- Independent read-only finish review returned **SHIP at this workstream's scope**, with no substantive correctness blockers. It reran the 13 service tests and reviewed all three fixture screenshots. Its only nonblocking note concerned an in-progress documentation sentence, already replaced by this verification report. It did not verify the parent integration or a live provider.
- Tool limitation: launching the Playwright check under Bun timed out before producing evidence; running the same check under Node completed successfully. Use the Node command above. The shell wrapper also prints an unrelated PowerShell `export` preamble error; the reported successful test/build commands completed afterward.
- **Parent integration remains required**: HTTP routing/guards, launch lifecycle/manual-edit protection, environment template, rebuild/export and the integrated end-to-end run are outside this workstream's file ownership.
- **Live-provider blocker**: no real provider upload was authorized or performed. Supply `PLUGGED_PINATA_JWT` server-side and obtain explicit approval before a paid live end-to-end pin. Provider account validity, quota and pin persistence were not verified. Missing-key unavailability and external-CID fallback were verified locally.

Provider reference: https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-file-to-ipfs
