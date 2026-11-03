import { translate } from './i18n.js';
// Operate mode: inherit Plugged's field/actions/receipt styles. A local preview leads
// to one explicit upload action; only a provider-confirmed CID updates the launch form.
const LIMIT = 2 * 1024 * 1024;
let nextId = 0;
const knownCode = code => typeof code === 'string' && translate('en', 'media.' + code) !== 'media.' + code;

export function mediaUploader({ language = () => 'en', esc, onPinned } = {}) {
  // Text is assigned through DOM APIs; esc is accepted for the host component contract.
  void esc;
  const text = key => { const lang = typeof language === 'function' ? language() : language; const value = translate(lang, 'media.' + key); return value === 'media.' + key ? translate(lang, 'media.provider_failure') : value; };
  let root, nodes, available = false, checking = false, busy = false, revision = 0;
  let file, dataUrl, pinned, reader, xhr, statusController, previewImage;

  function say(key, error = false, suffix = '') {
    if (!nodes) return;
    nodes.status.hidden = error;
    nodes.error.hidden = !error;
    nodes.status.textContent = error ? '' : `${text(key)}${suffix}`;
    nodes.error.textContent = error ? text(key) : '';
  }
  function controls() {
    if (!nodes) return;
    nodes.file.disabled = busy || !available;
    nodes.upload.disabled = busy || !available || !dataUrl || Boolean(pinned);
    nodes.cancel.hidden = !busy;
    nodes.remove.hidden = !file || busy;
    nodes.retry.hidden = available || checking;
    nodes.progress.hidden = !busy;
    nodes.public.hidden = !available;
    nodes.progress.setAttribute('aria-label', text('sending'));
  }
  function clearPreview(resetInput = true) {
    if (previewImage) { previewImage.onload = null; previewImage.onerror = null; previewImage.src = ''; previewImage = null; }
    file = dataUrl = pinned = null;
    if (!nodes) return;
    nodes.preview.removeAttribute('src'); nodes.preview.hidden = true;
    nodes.details.textContent = ''; nodes.details.hidden = true;
    if (resetInput) nodes.file.value = '';
    nodes.cidWrap.hidden = true; nodes.cid.value = '';
  }
  function interrupt() {
    revision++;
    reader?.abort(); reader = null;
    xhr?.abort(); xhr = null;
    busy = false;
  }
  async function availability() {
    statusController?.abort();
    const controller = statusController = new AbortController();
    checking = true; available = false; say('checking'); controls();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('/api/media/status', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json();
      if (statusController !== controller || !nodes) return;
      available = response.ok && result.available === true;
      say(available ? 'ready' : 'unavailable', !available);
    } catch {
      if (statusController === controller && nodes) say('connection', true);
    } finally {
      clearTimeout(timer);
      if (statusController === controller) { checking = false; controls(); }
    }
  }
  async function choose() {
    const selected = nodes.file.files?.[0];
    interrupt(); clearPreview(false);
    if (!selected) { say('ready'); controls(); return; }
    file = selected;
    const current = revision;
    if (selected.size > LIMIT) { say('too_large', true); controls(); return; }
    if (!selected.size || (selected.type && selected.type !== 'image/png') || !/\.png$/i.test(selected.name)) {
      say('unsupported_image', true); controls(); return;
    }
    busy = true; nodes.progress.removeAttribute('value'); say('reading'); controls();
    try {
      const header = new Uint8Array(await selected.slice(0, 33).arrayBuffer());
      if (current !== revision || !nodes) return;
      if (header.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((n, i) => header[i] !== n)) throw new Error('unsupported_image');
      const view = new DataView(header.buffer), width = view.getUint32(16), height = view.getUint32(20);
      if (width < 16 || height < 16 || width > 2048 || height > 2048) throw new Error('invalid_dimensions');
      if (header[24] !== 8 || ![2, 6].includes(header[25]) || header[28] !== 0) throw new Error('unsupported_image');
      const value = await new Promise((resolve, reject) => {
        const r = reader = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('invalid_image'));
        r.onabort = () => reject(new Error('cancelled'));
        r.readAsDataURL(new Blob([selected], { type: 'image/png' }));
      });
      if (current !== revision || !nodes) return;
      await new Promise((resolve, reject) => {
        const image = previewImage = new Image();
        image.onload = () => image.naturalWidth === width && image.naturalHeight === height ? resolve() : reject(new Error('invalid_image'));
        image.onerror = () => reject(new Error('invalid_image'));
        image.src = value;
      });
      if (current !== revision || !nodes) return;
      dataUrl = value;
      const scale = Math.min(160 / width, 160 / height, 1);
      nodes.preview.width = Math.round(width * scale); nodes.preview.height = Math.round(height * scale);
      nodes.preview.src = value; nodes.preview.hidden = false;
      // Avoid echoing an attacker-chosen filename into markup or long unbroken layout.
      const locale = typeof language === 'function' ? language() : language;
      nodes.details.textContent = `${width} × ${height} px · ${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(selected.size / 1024)} KiB`;
      nodes.details.hidden = false;
      say('selected');
    } catch (error) {
      if (current === revision && nodes) say(knownCode(error.message) ? error.message : 'invalid_image', true);
    } finally {
      if (current === revision) { busy = false; reader = null; controls(); }
    }
  }
  function upload() {
    if (!available || busy || !dataUrl || pinned || !nodes) return;
    const current = ++revision;
    busy = true; nodes.progress.value = 0; say('sending'); controls();
    const request = xhr = new XMLHttpRequest();
    request.open('POST', '/api/media/pin');
    request.timeout = 60_000;
    request.setRequestHeader('Content-Type', 'application/json');
    request.upload.onprogress = event => {
      if (current !== revision || !nodes) return;
      if (event.lengthComputable) {
        const percent = Math.floor(event.loaded / event.total * 100);
        nodes.progress.value = percent; say('sending', false, ` · ${percent}%`);
      }
    };
    request.upload.onload = () => {
      if (current === revision && nodes) { nodes.progress.removeAttribute('value'); say('pinning'); }
    };
    const finish = (key, isError = true) => {
      if (current !== revision || !nodes) return;
      busy = false; xhr = null; say(key, isError); controls();
    };
    request.onerror = () => finish('connection');
    request.ontimeout = () => finish('timeout');
    request.onabort = () => finish('cancelled');
    request.onload = () => {
      if (current !== revision || !nodes) return;
      let result;
      try { result = JSON.parse(request.responseText); } catch { finish('provider_failure'); return; }
      if (request.status < 200 || request.status >= 300) {
        finish(knownCode(result?.code) ? result.code : 'provider_failure'); return;
      }
      if (!/^b(?:afkrei|afybei)[a-z2-7]{52}$/.test(result?.cid || '') || result.contentType !== 'image/png') {
        finish('provider_failure'); return;
      }
      pinned = result;
      nodes.cid.value = result.cid; nodes.cidWrap.hidden = false;
      finish('success', false);
      try { onPinned?.(result); } catch { say('apply_failure', true); }
    };
    try {
      request.send(JSON.stringify({ filename: file.name, contentType: 'image/png', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) }));
    } catch { finish('connection'); }
  }
  function click(event) {
    const action = event.target.closest('button[data-media-action]')?.dataset.mediaAction;
    if (action === 'upload') upload();
    if (action === 'cancel') { interrupt(); say('cancelled'); controls(); nodes.upload.focus(); }
    if (action === 'remove') { interrupt(); clearPreview(); say('ready'); controls(); nodes.file.focus(); }
    if (action === 'retry') void availability();
  }
  function mount(target) {
    destroy(); root = target;
    if (!root) throw new TypeError('Media uploader needs a root element');
    const id = `media-${++nextId}`;
    // Static markup only; all translated text and server data use textContent/value.
    root.innerHTML = `<div class="media-uploader field full">
      <label class="field" data-node="label"><input type="file" name="mediaFile" autocomplete="off" accept="image/png,.png" data-node="file"></label>
      <p class="receipt-note" data-node="help"></p>
      <img data-node="preview" width="160" height="160" hidden>
      <p class="receipt-note" data-node="details" hidden></p>
      <p class="receipt-note" data-node="public"></p>
      <div class="form-actions"><button type="button" class="primary" data-media-action="upload" data-node="upload"></button>
      <button type="button" data-media-action="cancel" data-node="cancel" hidden></button>
      <button type="button" data-media-action="remove" data-node="remove" hidden></button>
      <button type="button" data-media-action="retry" data-node="retry" hidden></button></div>
      <progress max="100" data-node="progress" hidden></progress>
      <p class="receipt-note" role="status" aria-live="polite" aria-atomic="true" data-node="status"></p>
      <p class="error-list" role="alert" data-node="error" hidden></p>
      <label class="field" data-node="cidWrap" hidden><span data-node="cidLabel"></span><input type="text" name="mediaPinnedCid" autocomplete="off" readonly data-node="cid" spellcheck="false" translate="no"></label>
      <p class="receipt-note" data-node="fallback"></p>
    </div>`;
    nodes = Object.fromEntries([...root.querySelectorAll('[data-node]')].map(el => [el.dataset.node, el]));
    nodes.label.prepend(document.createTextNode(text('label')));
    for (const key of ['help', 'public', 'upload', 'cancel', 'remove', 'retry', 'fallback']) nodes[key].textContent = text(key);
    nodes.preview.alt = text('preview'); nodes.cidLabel.textContent = text('cid');
    nodes.help.id = `${id}-help`; nodes.error.id = `${id}-error`;
    nodes.file.setAttribute('aria-describedby', `${id}-help ${id}-error`);
    nodes.file.addEventListener('change', choose); root.addEventListener('click', click);
    void availability();
  }
  function destroy() {
    interrupt(); statusController?.abort(); statusController = null;
    clearPreview();
    nodes?.file.removeEventListener('change', choose);
    root?.removeEventListener('click', click);
    if (root) root.replaceChildren();
    root = nodes = null; available = checking = false;
  }
  return { mount, destroy };
}
