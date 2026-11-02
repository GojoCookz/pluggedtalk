import { randomUUID } from 'node:crypto';
import { isAddress, zeroAddress, erc20Abi, encodeFunctionData, decodeFunctionData, decodeEventLog, keccak256, parseAbi, toHex } from '../../app/node_modules/viem/_esm/index.js';

// PluggedFeeVault (contracts/src/PluggedFeeVault.sol). States follow the Solidity enum order.
export const FEE_VAULT_STATES = ['none', 'pending', 'accepted', 'declined', 'reclaimed', 'expired'];
const CONTAINER = '(address allocator,uint40 createdAt,uint40 deadline,uint8 state,address recipient,address currency,address operator,address inbox,bytes32 inviteRef,uint256 balance,uint256 credited,uint256 paid)';
export const FEE_VAULT_ABI = parseAbi([
  `function getContainer(uint256 id) view returns (${CONTAINER})`,
  'function containerCount() view returns (uint256)',
  'function claimable(uint256 id) view returns (uint256)',
  'function reclaimable(uint256 id) view returns (uint256)',
  'function inboxBalance(uint256 id) view returns (uint256)',
  'function totalHeld(address currency) view returns (uint256)',
  'function recipientContainerCount(address) view returns (uint256)',
  'function allocatorContainerCount(address) view returns (uint256)',
  'function recipientContainers(address,uint256,uint256) view returns (uint256[])',
  'function allocatorContainers(address,uint256,uint256) view returns (uint256[])',
  'function accept(uint256 id)',
  'function decline(uint256 id)',
  'function claim(uint256 id) returns (uint256)',
  'function reclaim(uint256 id) returns (uint256)',
  'function sweepInbox(uint256 id) returns (uint256)',
  'function operatorReturn(uint256 id) returns (uint256)',
  'function extendDeadline(uint256 id,uint40 newDeadline)',
  'function createContainer(address recipient,address currency,uint256 window,address operator,bytes32 inviteRef) returns (uint256 id,address inbox)',
  'error InvalidRecipient()',
  'error InvalidCurrency()',
  'error InvalidWindow()',
  'event ContainerCreated(uint256 indexed id,address indexed allocator,address indexed recipient,address currency,address inbox,address operator,uint40 deadline,bytes32 inviteRef)',
  'event Accepted(uint256 indexed id,address indexed recipient,uint256 balance)',
  'event Declined(uint256 indexed id,address indexed recipient,uint256 balance)',
  'event Claimed(uint256 indexed id,address indexed recipient,address currency,uint256 amount)',
  'event Reclaimed(uint256 indexed id,address indexed allocator,address indexed caller,address currency,uint256 amount)',
  'event InboxSwept(uint256 indexed id,address indexed caller,uint256 amount)',
  'event DeadlineExtended(uint256 indexed id,address indexed caller,uint40 previousDeadline,uint40 newDeadline)',
]);

// action -> [function, receipt event, who may sign]
const ACTIONS = {
  accept: ['accept', 'Accepted', 'recipient'],
  decline: ['decline', 'Declined', 'recipient'],
  claim: ['claim', 'Claimed', 'recipient'],
  reclaim: ['reclaim', 'Reclaimed', 'allocator'],
  sweep: ['sweepInbox', 'InboxSwept', 'anyone'],
  operatorReturn: ['operatorReturn', 'Reclaimed', 'operator'],
  extend: ['extendDeadline', 'DeadlineExtended', 'allocatorOrOperator'],
  create: ['createContainer', 'ContainerCreated', 'anyone'],
};
const ZERO_REF = `0x${'0'.repeat(64)}`;
const vaultErrorName = e => { for (let x = e; x; x = x.cause) { if (x.data?.errorName) return x.data.errorName; } return null; };
const BY_FUNCTION = Object.fromEntries(Object.entries(ACTIONS).map(([action, [fn]]) => [fn, action]));
const PAGE = 100;
const DAY = 86400;

export class FeeVaultError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (message, status = 422) => { throw new FeeVaultError(status, message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const safe = x => JSON.parse(JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const address = (a, label = 'Wallet') => { if (!isAddress(a ?? '', { strict: false }) || same(a, zeroAddress)) fail(`${label}: enter a nonzero EVM address.`); return a.toLowerCase(); };
function fields(raw, allowed) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Provide a JSON object.');
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) fail(`Unsupported vault input: ${k}.`);
}
const containerId = v => { if (typeof v !== 'string' || !/^[1-9][0-9]{0,30}$/.test(v)) fail('Provide a container ID.'); return BigInt(v); };

/** Server-configured manifest only: {address, codeHash, chainId}. Never accepted over HTTP. */
export function feeVaultManifestFromEnv(env = process.env) {
  if (!env.PLUGGED_FEE_VAULT_ADDRESS) return null;
  return { address: env.PLUGGED_FEE_VAULT_ADDRESS, codeHash: env.PLUGGED_FEE_VAULT_CODEHASH, chainId: 4663 };
}

export class FeeVaultService {
  constructor({ client, manifest = null, chainId = 4663, symbols = {}, now = Date.now, confirmations = 2 } = {}) {
    this.chainId = chainId; this.now = now; this.confirmations = BigInt(confirmations); this.symbols = symbols;
    this.preparations = new Map(); this.reason = null;
    if (!manifest) { this.manifest = null; this.reason = 'Fee vault is not deployed or not configured on this server.'; }
    else {
      if (!isAddress(manifest.address ?? '', { strict: false }) || !/^0x[0-9a-f]{64}$/i.test(manifest.codeHash ?? '') || manifest.chainId !== chainId) throw new Error('Invalid fee vault manifest.');
      this.manifest = { ...manifest, address: manifest.address.toLowerCase() };
    }
    this.getClient = typeof client === 'function' ? client : () => client;
  }
  get client() { const c = this.getClient(); if (!c) fail('Fee vault RPC is unavailable.', 503); return c; }
  status() {
    return { deployed: Boolean(this.manifest), chainId: this.chainId, address: this.manifest?.address ?? null, reason: this.reason,
      windows: { minDays: 7, defaultDays: 30, maxDays: 365 } };
  }
  ready() { if (!this.manifest) fail(this.reason, 503); return this.manifest.address; }
  read(functionName, args, blockNumber) { return this.client.readContract({ address: this.manifest.address, abi: FEE_VAULT_ABI, functionName, args, blockNumber }); }
  async verified(blockNumber) {
    const target = this.ready();
    if (await this.client.getChainId() !== this.chainId) fail(`Vault RPC must be chain ${this.chainId}.`, 503);
    const code = await this.client.getCode({ address: target, blockNumber });
    // Fail closed: an address without the exact audited runtime is treated as undeployed.
    if (!code || code === '0x' || keccak256(code) !== this.manifest.codeHash.toLowerCase()) fail('Fee vault deployment verification failed. Actions are disabled.', 503);
    return target;
  }
  async currency(currency, blockNumber, cache) {
    const key = currency.toLowerCase();
    if (!cache.has(key)) cache.set(key, (async () => {
      if (same(currency, zeroAddress)) return { decimals: 18, symbol: 'ETH' };
      const decimals = await this.client.readContract({ address: currency, abi: erc20Abi, functionName: 'decimals', blockNumber });
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) fail('Invalid vault currency decimals.');
      return { decimals, symbol: this.symbols[key] ?? key };
    })());
    return cache.get(key);
  }
  async container(id, blockNumber, cache = new Map(), timestamp) {
    const [c, claimable, reclaimable, inbox] = await Promise.all([this.read('getContainer', [id], blockNumber), this.read('claimable', [id], blockNumber), this.read('reclaimable', [id], blockNumber), this.read('inboxBalance', [id], blockNumber)]);
    const meta = await this.currency(c.currency, blockNumber, cache), state = FEE_VAULT_STATES[c.state] ?? 'unknown';
    const secondsLeft = state === 'pending' ? Math.max(0, Number(c.deadline) - Number(timestamp)) : 0;
    return { id: id.toString(), state, allocator: c.allocator.toLowerCase(), recipient: c.recipient.toLowerCase(), currency: c.currency.toLowerCase(),
      operator: same(c.operator, zeroAddress) ? null : c.operator.toLowerCase(), inbox: c.inbox.toLowerCase(), inviteRef: c.inviteRef,
      createdAt: Number(c.createdAt), deadline: Number(c.deadline), secondsLeft, ...meta,
      // Credits shown in the UI are exactly these on-chain values at blockNumber.
      balance: c.balance, inboxBalance: inbox, credited: c.credited, paid: c.paid, claimable, reclaimable };
  }
  async ids(kind, account, blockNumber) {
    const [countFn, listFn] = kind === 'recipient' ? ['recipientContainerCount', 'recipientContainers'] : ['allocatorContainerCount', 'allocatorContainers'];
    const count = await this.read(countFn, [account], blockNumber);
    // Newest first, bounded. Spam containers addressed to a recipient cannot hide the newest page.
    const offset = count > BigInt(PAGE) ? count - BigInt(PAGE) : 0n;
    const ids = await this.read(listFn, [account, offset, BigInt(PAGE)], blockNumber);
    return { ids: [...ids].reverse(), truncated: count > BigInt(PAGE), total: count };
  }
  actionsFor(c, account) {
    const me = r => same(c[r], account);
    return {
      accept: me('recipient') && c.state === 'pending', decline: me('recipient') && c.state === 'pending',
      claim: me('recipient') && c.state === 'accepted' && c.claimable > 0n,
      reclaim: me('allocator') && ['declined', 'expired', 'reclaimed'].includes(c.state) && c.reclaimable > 0n,
      operatorReturn: me('operator') && ['pending', 'expired', 'declined', 'reclaimed'].includes(c.state) && (c.balance + c.inboxBalance) > 0n,
      extend: (me('allocator') || me('operator')) && ['pending', 'expired'].includes(c.state),
      sweep: c.inboxBalance > 0n,
    };
  }
  async containers(raw) {
    fields(raw, ['account', 'chainId']);
    if (raw.chainId !== this.chainId) fail(`Select chain ${this.chainId}.`);
    const account = address(raw.account);
    if (!this.manifest) return { ...this.status(), account, recipient: [], allocator: [], operator: [] };
    const blockNumber = await this.client.getBlockNumber(); await this.verified(blockNumber);
    const block = await this.client.getBlock({ blockNumber }), cache = new Map();
    const [asRecipient, asAllocator] = await Promise.all([this.ids('recipient', account, blockNumber), this.ids('allocator', account, blockNumber)]);
    const load = async list => Promise.all(list.ids.map(async id => { const c = await this.container(id, blockNumber, cache, block.timestamp); return { ...c, actions: this.actionsFor(c, account) }; }));
    const [recipient, allocator] = await Promise.all([load(asRecipient), load(asAllocator)]);
    // Conservation check per currency seen: vault must hold at least the sum it owes.
    const conservation = [];
    for (const currency of new Set([...recipient, ...allocator].map(c => c.currency))) {
      const held = await this.read('totalHeld', [currency], blockNumber);
      const balance = same(currency, zeroAddress) ? await this.client.getBalance({ address: this.manifest.address, blockNumber }) : await this.client.readContract({ address: currency, abi: erc20Abi, functionName: 'balanceOf', args: [this.manifest.address], blockNumber });
      if (balance < held) fail('Vault balance is below recorded credits. Actions are disabled pending investigation.', 503);
      conservation.push({ currency, totalHeld: held, vaultBalance: balance });
    }
    return safe({ ...this.status(), account, blockNumber, blockTimestamp: Number(block.timestamp), recipient, allocator,
      truncated: { recipient: asRecipient.truncated, allocator: asAllocator.truncated }, conservation,
      notes: ['Accepting proves control of the exact payout wallet; accepted balances can never be reclaimed.', 'Unaccepted containers return to the allocator only after decline or expiry.'] });
  }
  async prepare(raw) {
    fields(raw, ['account', 'chainId', 'action', 'id', 'deadline', 'recipient', 'currency', 'windowDays']);
    if (raw.chainId !== this.chainId) fail(`Select chain ${this.chainId}.`);
    const account = address(raw.account), target = this.ready();
    if (!Object.hasOwn(ACTIONS, raw.action)) fail('Unknown vault action.');
    if (raw.action === 'create') return this.prepareCreate(raw, account, target);
    for (const k of ['recipient', 'currency', 'windowDays']) if (raw[k] !== undefined) fail(`Unsupported vault input: ${k}.`);
    if (raw.action !== 'extend' && raw.deadline !== undefined) fail('Only extend accepts a deadline.');
    const id = containerId(raw.id), preparedBlock = await this.client.getBlockNumber();
    await this.verified(preparedBlock);
    const block = await this.client.getBlock({ blockNumber: preparedBlock });
    const c = await this.container(id, preparedBlock, new Map(), block.timestamp);
    if (!this.actionsFor(c, account)[raw.action]) fail('This wallet cannot perform that action on this container now. Refresh.');
    const [functionName, event] = ACTIONS[raw.action];
    let args = [id];
    if (raw.action === 'extend') {
      if (!Number.isInteger(raw.deadline)) fail('Provide the new deadline as a Unix timestamp.');
      const now = Number(block.timestamp);
      if (raw.deadline <= c.deadline || raw.deadline <= now || raw.deadline > now + 365 * DAY) fail('New deadline must be later than the current one and within 365 days.');
      args = [id, raw.deadline];
    }
    const call = { account, address: target, abi: FEE_VAULT_ABI, functionName, args };
    const { result } = await this.client.simulateContract(call);
    const gas = await this.client.estimateContractGas(call), createdAt = this.now();
    const expectedAmount = raw.action === 'claim' ? c.claimable : ['reclaim', 'operatorReturn'].includes(raw.action) ? c.reclaimable || c.balance + c.inboxBalance : raw.action === 'sweep' ? c.inboxBalance : 0n;
    if (['claim', 'reclaim', 'operatorReturn', 'sweep'].includes(raw.action) && result !== undefined && result !== expectedAmount) fail('Simulation amount differs from the vault balance. Refresh.');
    const record = safe({ id: randomUUID(), account, chainId: this.chainId, action: raw.action, containerId: id, status: 'prepared', createdAt, expiresAt: createdAt + 120000, preparedBlock,
      transaction: { from: account, to: target, chainId: toHex(this.chainId), value: '0x0', data: encodeFunctionData({ abi: FEE_VAULT_ABI, functionName, args }), gas: toHex(gas * 120n / 100n) },
      expected: { event, amount: expectedAmount, currency: c.currency, symbol: c.symbol, decimals: c.decimals, payee: raw.action === 'claim' ? c.recipient : ['reclaim', 'operatorReturn'].includes(raw.action) ? c.allocator : null, deadline: c.deadline, state: c.state },
      simulation: { result: result ?? null, gas }, notes: ['Simulation is not a payout guarantee.', raw.action === 'accept' ? 'After acceptance the allocator can never reclaim this container.' : 'Funds move only to the fixed recipient or allocator.'] });
    return this.remember(record);
  }
  remember(record) {
    this.preparations.set(record.id, record);
    for (const [k, v] of this.preparations) if (v.expiresAt + 3600000 < record.createdAt) this.preparations.delete(k);
    return record;
  }
  /** New container held for `recipient` in `currency`. The caller (signer) becomes the allocator. */
  async prepareCreate(raw, account, target) {
    for (const k of ['id', 'deadline']) if (raw[k] !== undefined) fail(`Unsupported vault input: ${k}.`);
    const recipient = address(raw.recipient, 'Recipient');
    if (same(recipient, account)) fail('The container recipient must differ from the creating wallet.');
    if (typeof raw.currency !== 'string' || !isAddress(raw.currency, { strict: false })) fail('Container currency must be ETH or a token contract.');
    const currency = raw.currency.toLowerCase();
    if (!Number.isInteger(raw.windowDays) || raw.windowDays < 7 || raw.windowDays > 365) fail('Container window: use whole days from 7 to 365.');
    const preparedBlock = await this.client.getBlockNumber();
    await this.verified(preparedBlock);
    if (!same(currency, zeroAddress)) { const code = await this.client.getCode({ address: currency, blockNumber: preparedBlock }); if (!code || code === '0x') fail('Container currency must be ETH or a token contract.'); }
    const meta = await this.currency(currency, preparedBlock, new Map());
    const count = await this.read('containerCount', [], preparedBlock);
    const args = [recipient, currency, BigInt(raw.windowDays * DAY), zeroAddress, ZERO_REF];
    const call = { account, address: target, abi: FEE_VAULT_ABI, functionName: 'createContainer', args, blockNumber: preparedBlock };
    let result;
    try { ({ result } = await this.client.simulateContract(call)); }
    catch (e) { const name = vaultErrorName(e); if (name) fail(`Vault rejected create (${name}).`); throw e; }
    const [predictedId, predictedInbox] = result ?? [];
    // Prediction at the pinned block. Another creation landing first shifts the id/inbox, so the
    // UI uses only the inbox from the confirmed ContainerCreated event.
    if (predictedId !== count + 1n || !isAddress(predictedInbox ?? '', { strict: false })) fail('Simulation differs from the vault container count. Refresh.');
    const { blockNumber: _pin, ...estimate } = call;
    const gas = await this.client.estimateContractGas(estimate), createdAt = this.now();
    return this.remember(safe({ id: randomUUID(), account, chainId: this.chainId, action: 'create', containerId: null, status: 'prepared', createdAt, expiresAt: createdAt + 120000, preparedBlock,
      transaction: { from: account, to: target, chainId: toHex(this.chainId), value: '0x0', data: encodeFunctionData({ abi: FEE_VAULT_ABI, functionName: 'createContainer', args }), gas: toHex(gas * 120n / 100n) },
      expected: { event: 'ContainerCreated', recipient, currency, symbol: meta.symbol, decimals: meta.decimals, windowDays: raw.windowDays, allocator: account, operator: null, predictedId, predictedInbox: predictedInbox.toLowerCase() },
      simulation: { result: [predictedId, predictedInbox.toLowerCase()], gas },
      notes: ['The predicted inbox is final only after confirmation; use the confirmed inbox as the fee recipient.', 'Unaccepted funds return to this wallet only after decline or expiry.'] }));
  }
  /** Stateless: verification decodes the transaction itself, so it survives restarts. */
  async submit(raw) {
    fields(raw, ['id', 'txHash', 'account', 'chainId']);
    if (raw.chainId !== this.chainId) fail(`Select chain ${this.chainId}.`);
    const account = address(raw.account), target = this.ready();
    if (!/^0x[0-9a-f]{64}$/i.test(raw.txHash ?? '')) fail('Provide a transaction hash.');
    const prep = raw.id === undefined ? null : this.preparations.get(raw.id);
    if (raw.id !== undefined && (!prep || !same(prep.account, account))) fail('Preparation not found for this wallet.');
    const response = (status, extra = {}) => safe({ status, txHash: raw.txHash, chainId: this.chainId, account, verified: status === 'confirmed', ...extra });
    let tx;
    try { tx = await this.client.getTransaction({ hash: raw.txHash }); } catch (e) { if (e.name === 'TransactionNotFoundError') return response('unknown'); throw e; }
    if (!same(tx.from, account) || !same(tx.to, target) || tx.value !== 0n || (tx.chainId !== undefined && tx.chainId !== this.chainId)) fail('Transaction is not a vault call from this wallet.');
    if (prep && !same(tx.input, prep.transaction.data)) fail('Transaction differs from the prepared calldata.');
    let decoded; try { decoded = decodeFunctionData({ abi: FEE_VAULT_ABI, data: tx.input }); } catch { fail('Transaction is not a vault call from this wallet.'); }
    const action = BY_FUNCTION[decoded.functionName]; if (!action) fail('Transaction is not a vault action.');
    const id = action === 'create' ? null : decoded.args[0];
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: raw.txHash }); } catch (e) { if (e.name === 'TransactionReceiptNotFoundError') return response('pending', { action, containerId: id }); throw e; }
    if (!same(receipt.transactionHash, raw.txHash) || !same(receipt.from, account) || !same(receipt.to, target)) fail('Receipt does not match the submitted transaction.');
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (!same(block.hash, receipt.blockHash)) return response('reorg', { action, containerId: id });
    const latest = await this.client.getBlockNumber();
    if (latest < receipt.blockNumber + this.confirmations) return response('confirming', { action, containerId: id, confirmations: Number(latest - receipt.blockNumber + 1n), requiredConfirmations: Number(this.confirmations) + 1 });
    if (receipt.status !== 'success') return response('reverted', { action, containerId: id });
    const eventName = ACTIONS[action][1];
    const decodedLogs = receipt.logs.filter(l => same(l.address, target)).flatMap(l => { try { return [decodeEventLog({ abi: FEE_VAULT_ABI, data: l.data, topics: l.topics, strict: true })]; } catch { return []; } });
    if (action === 'create') {
      const created = decodedLogs.filter(e => e.eventName === 'ContainerCreated');
      if (created.length !== 1) fail('Expected exactly one matching vault event in the receipt.');
      const a = created[0].args, [recipient, currency, , operator] = decoded.args;
      if (!same(a.allocator, account) || !same(a.recipient, recipient) || !same(a.currency, currency) || !same(a.operator, operator)) fail('Created container differs from the signed request.');
      // Cross-check storage at the receipt block: the inbox is the address the vault itself recorded.
      const c = await this.read('getContainer', [a.id], receipt.blockNumber);
      if (!same(c.inbox, a.inbox) || !same(c.recipient, recipient) || !same(c.currency, currency) || !same(c.allocator, account)) fail('Created container differs from the signed request.');
      if (prep) prep.status = 'confirmed';
      return response('confirmed', { action, containerId: a.id, inbox: a.inbox.toLowerCase(), recipient: a.recipient.toLowerCase(), currency: a.currency.toLowerCase(), deadline: Number(a.deadline),
        receipt: { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, event: 'ContainerCreated', args: a } });
    }
    const events = decodedLogs.filter(e => e.eventName === eventName && e.args.id === id);
    if (events.length !== 1) fail('Expected exactly one matching vault event in the receipt.');
    const args = events[0].args;
    if (action === 'claim' && (!same(args.recipient, account) || args.amount <= 0n)) fail('Claim event does not pay this wallet.');
    if (['accept', 'decline'].includes(action) && !same(args.recipient, account)) fail('Event recipient differs from signer.');
    if (prep) prep.status = 'confirmed';
    return response('confirmed', { action, containerId: id, receipt: { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, event: eventName, args } });
  }
}
