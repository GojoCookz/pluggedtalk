const ERRORS = Object.freeze({
  unavailable: [503, 'Image uploads are unavailable. Paste an existing image CID instead.'],
  invalid_request: [400, 'Use filename, contentType and base64 image data only.'],
  invalid_filename: [400, 'Choose a PNG with a simple filename ending in .png.'],
  unsupported_image: [415, 'Use a noninterlaced 8-bit RGB or RGBA PNG. Export your image as PNG and retry.'],
  invalid_image: [422, 'This PNG is damaged or contains unsupported data. Export a fresh PNG and retry.'],
  too_large: [413, 'Image must be at most 2 MiB, including after processing.'],
  invalid_dimensions: [422, 'Image width and height must each be 16–2048 pixels.'],
  busy: [429, 'Image uploads are busy. Wait a moment and retry.'],
  provider_unavailable: [503, 'The image provider is unavailable. Retry later or paste an existing image CID.'],
  provider_failure: [502, 'The image provider did not confirm a valid pin. Retry or paste an existing image CID.'],
  timeout: [504, 'Image upload timed out. It may already be pinned. Retry or use an existing image CID.'],
  cancelled: [499, 'Upload cancelled. A pin already accepted by the provider may remain.'],
});

export class MediaError extends Error {
  constructor(code) {
    const [status, message] = ERRORS[code] || ERRORS.provider_failure;
    super(message);
    this.name = 'MediaError';
    this.code = Object.hasOwn(ERRORS, code) ? code : 'provider_failure';
    this.status = status;
  }
}

// Never forward an arbitrary Error.message, provider payload or credential-bearing cause.
export function mediaErrorResponse(error) {
  const code = error instanceof MediaError && Object.hasOwn(ERRORS, error.code) ? error.code : 'provider_failure';
  const [status, message] = ERRORS[code];
  return { status, body: { error: message, code } };
}
