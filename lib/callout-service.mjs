import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { erc20Abi, isAddress } from '../../app/node_modules/viem/_esm/index.js';
import { HttpError } from './http-api.mjs';
import { tokenAddress } from './activity-service.mjs';

// Wallet-signed callouts: short public posts about a verified Plugged launch.
// No accounts: the server issues a single-use challenge that embeds the exact text, the wallet
// signs it (EIP-191 personal_sign; ERC-1271 wallets verify through the RPC), and the server
// records the post with the author's on-chain token balance at that block.
export const CALLOUT_MODES = ['open', 'premoderated', 'readonly', 'off'];
export const MAX_CALLOUT_CHARS = 280;
const CHALLENGE_MS = 10 * 60 * 1000;
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|io|xyz|fun|gg|me|app|net|org|co|link|ly|to|finance|ai|so)\b|t\.me\/|discord\.gg)/i;
// Bidirectional overrides and zero-width characters can disguise text; reject rather than strip.
const DISGUISE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

export function cleanCallout(raw) {
  if (typeof raw !== 'string') throw new HttpError(422, 'Write a callout.');
  if (raw.length > MAX_CALLOUT_CHARS * 4) throw new HttpError(413, 'Callout is too long.');
  if (DISGUISE.test(raw)) throw new HttpError(422, 'Callout contains hidden formatting characters.');
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new HttpError(422, 'Write a callout.');
  if ([...text].length > MAX_CALLOUT_CHARS) throw new HttpError(422, `Callouts are limited to ${MAX_CALLOUT_CHARS} characters.`);
  if (/[<>]/.test(text)) throw new HttpError(422, 'Callouts cannot contain HTML.');
  if (LINK.test(text)) throw new HttpError(422, 'Callouts cannot contain links.');
  return text;
}

export function calloutMessage({ origin, token, account, nonce, issuedAt, text }) {
  return `Plugged callout\nOrigin: ${origin}\nChain: 4663\nToken: ${token}\nAuthor: ${account}\nNonce: ${nonce}\nIssued: ${issuedAt}\n\n${text}`;
}

export class CalloutService {
  constructor({ db, activity, client, verify, mode = 'open', origin = 'http://localhost', now = Date.now, perWallet10m = 3, perWalletDay = 20, hideAfterReports = 3 }) {
    if (!CALLOUT_MODES.includes(mode)) throw new Error(`PLUGGED_CALLOUTS must be one of ${CALLOUT_MODES.join(', ')}.`);
    Object.assign(this, { db, activity, client, mode, origin, now, perWallet10m, perWalletDay, hideAfterReports });
    this.verify = verify ?? (args => this.client().verifyMessage(args));
    db.exec(`CREATE TABLE IF NOT EXISTS callout_challenges (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT NOT NULL, text TEXT NOT NULL,
        message TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS callouts (id TEXT PRIMARY KEY, token TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL,
        position TEXT, position_block TEXT, signature TEXT NOT NULL UNIQUE, hidden INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS callout_token ON callouts(token, created);
      CREATE INDEX IF NOT EXISTS callout_author ON callouts(author, created);
      CREATE TABLE IF NOT EXISTS callout_reports (callout TEXT NOT NULL, reporter TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (callout, reporter));
      CREATE TABLE IF NOT EXISTS callout_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.query("INSERT OR IGNORE INTO callout_meta VALUES ('salt', ?)").run(randomBytes(32).toString('hex'));
    this.salt = db.query("SELECT value FROM callout_meta WHERE key='salt'").get().value;
  }

  status() { return { mode: this.mode, maxChars: MAX_CALLOUT_CHARS, perWallet10m: this.perWallet10m, perWalletDay: this.perWalletDay, links: false, signing: 'eip-191' }; }

  writable() {
    if (this.mode === 'off' || this.mode === 'readonly') throw new HttpError(503, 'Callouts are read-only right now.');
  }

  account(value) {
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new HttpError(422, 'Connect a wallet.');
    return value.toLowerCase();
  }

  challenge(input) {
    this.writable();
    if (!input || Object.keys(input).some(k => !['account', 'token', 'text'].includes(k))) throw new HttpError(422, 'Unsupported request fields.');
    const account = this.account(input.account), meta = this.activity.meta(input.token), text = cleanCallout(input.text);
    this.rateLimit(account);
    const at = this.now();
    this.db.query('DELETE FROM callout_challenges WHERE created < ?').run(at - CHALLENGE_MS * 6);
    const pending = this.db.query('SELECT count(*) AS n FROM callout_challenges WHERE account = ? AND used = 0 AND created >= ?').get(account, at - CHALLENGE_MS).n;
    if (pending >= 5) throw new HttpError(429, 'Too many unsigned callouts. Sign or wait ten minutes.');
    const nonce = randomBytes(16).toString('hex'), issuedAt = new Date(at).toISOString();
    const message = calloutMessage({ origin: this.origin, token: meta.token, account, nonce, issuedAt, text });
    this.db.query('INSERT INTO callout_challenges VALUES (?,?,?,?,?,?,0)').run(nonce, account, meta.token, text, message, at);
    return { nonce, message, expiresAt: new Date(at + CHALLENGE_MS).toISOString() };
  }

  rateLimit(account) {
    const at = this.now(), count = since => this.db.query('SELECT count(*) AS n FROM callouts WHERE author = ? AND created >= ?').get(account, since).n;
    if (count(at - 600000) >= this.perWallet10m) throw new HttpError(429, 'This wallet posted recently. Try again in a few minutes.');
    if (count(at - 86400000) >= this.perWalletDay) throw new HttpError(429, 'Daily callout limit reached for this wallet.');
  }

  async post(input) {
    this.writable();
    if (!input || Object.keys(input).some(k => !['nonce', 'signature'].includes(k))) throw new HttpError(422, 'Unsupported request fields.');
    if (typeof input.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(input.nonce)) throw new HttpError(422, 'Invalid challenge.');
    if (typeof input.signature !== 'string' || !/^0x[0-9a-f]{130,20000}$/i.test(input.signature)) throw new HttpError(422, 'Invalid signature.');
    const row = this.db.query('SELECT * FROM callout_challenges WHERE nonce = ?').get(input.nonce);
    if (!row || row.used) throw new HttpError(409, 'Challenge already used or unknown. Start again.');
    if (this.now() - row.created > CHALLENGE_MS) throw new HttpError(410, 'Challenge expired. Start again.');
    let valid = false;
    try { valid = await this.verify({ address: row.account, message: row.message, signature: input.signature }); } catch {}
    if (!valid) throw new HttpError(401, 'Signature does not match the wallet.');
    this.rateLimit(row.account);
    // Compare-and-set: concurrent submissions of one challenge cannot both post.
    if (this.db.query('UPDATE callout_challenges SET used = 1 WHERE nonce = ? AND used = 0').run(row.nonce).changes !== 1) throw new HttpError(409, 'Challenge already used or unknown. Start again.');
    let position = null, positionBlock = null;
    try {
      const block = await this.activity.head();
      position = (await this.client().readContract({ address: row.token, abi: erc20Abi, functionName: 'balanceOf', args: [row.account], blockNumber: block })).toString();
      positionBlock = block.toString();
    } catch {}
    const id = randomUUID(), created = this.now();
    try {
      this.db.query('INSERT INTO callouts (id, token, author, text, created, position, position_block, signature, hidden) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, row.token, row.account, row.text, created, position, positionBlock, input.signature.toLowerCase(), this.mode === 'premoderated' ? 1 : 0);
    } catch { throw new HttpError(409, 'This signature was already used.'); }
    return { callout: this.view(this.db.query('SELECT * FROM callouts WHERE id = ?').get(id)), pendingReview: this.mode === 'premoderated' };
  }

  view(r) { return { id: r.id, token: r.token, author: r.author, text: r.text, createdAt: new Date(r.created).toISOString(), position: r.position, positionBlock: r.position_block }; }

  list(query) {
    if (this.mode === 'off') return { mode: this.mode, callouts: [] };
    const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '30', 10) || 30, 1), 50);
    const token = query.get('token'), author = query.get('author');
    let rows;
    if (token) rows = this.db.query('SELECT * FROM callouts WHERE token = ? AND hidden = 0 ORDER BY created DESC LIMIT ?').all(tokenAddress(token), limit);
    else if (author) rows = this.db.query('SELECT * FROM callouts WHERE author = ? AND hidden = 0 ORDER BY created DESC LIMIT ?').all(tokenAddress(author), limit);
    else rows = this.db.query('SELECT * FROM callouts WHERE hidden = 0 ORDER BY created DESC LIMIT ?').all(limit);
    const symbols = new Map();
    const callouts = rows.map(r => {
      if (!symbols.has(r.token)) { try { const m = this.activity.meta(r.token); symbols.set(r.token, { symbol: m.symbol, name: m.name }); } catch { symbols.set(r.token, null); } }
      return { ...this.view(r), coin: symbols.get(r.token) };
    }).filter(c => c.coin);
    return { mode: this.mode, callouts, status: this.status() };
  }

  report(input, client) {
    if (!input || Object.keys(input).some(k => k !== 'id') || typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) throw new HttpError(422, 'Invalid callout.');
    const row = this.db.query('SELECT id, hidden FROM callouts WHERE id = ?').get(input.id);
    if (!row) throw new HttpError(404, 'Callout not found.');
    const reporter = createHash('sha256').update(`${this.salt}:${client}`).digest('hex');
    const added = this.db.query('INSERT OR IGNORE INTO callout_reports VALUES (?,?,?)').run(row.id, reporter, this.now()).changes === 1;
    if (added) this.db.query('UPDATE callouts SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ? THEN 1 ELSE hidden END WHERE id = ?').run(this.hideAfterReports, row.id);
    return { reported: true, duplicate: !added };
  }

  /** Operator-only (CLI); never routed over HTTP. */
  moderate(id, hidden) { return this.db.query('UPDATE callouts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id).changes === 1; }
}
