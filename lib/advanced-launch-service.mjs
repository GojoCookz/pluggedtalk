import { randomBytes, randomUUID } from 'node:crypto';
import { erc20Abi, encodeFunctionData, decodeEventLog, isAddress, parseUnits, toHex, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { ADVANCED_ENGINE, ADVANCED_FACTORY_ABI, LAUNCH_REGISTRY_ABI, ADVANCED_TOKEN_ABI, loadAdvancedArtifacts, encodeAdvancedLaunch } from './advanced-abi.mjs';
import { REGISTRY_ABI } from './carbon-abi.mjs';
import { loadDeploymentProfile, verifyDeploymentProfile } from './deployment-profile.mjs';
import { publicClient, jsonSafe } from './launch-service.mjs';
import { NETWORK, QUOTES } from './config.mjs';
import { usdValuation } from './market-services.mjs';
import { usdAmount } from './usd.mjs';
import { openingPoint, cidToBytes32, ZERO_BYTES32 } from './carbon-helpers.ts';

export const FULL_SUPPLY = 10n ** 27n;
export const CAP_TOLERANCE_BPS = 200;
const TICK_SPACING = 60;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = message => { throw Object.assign(new Error(message), { advanced: true }); };
const integer = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) fail(`${label}: use an integer from ${min} to ${max}.`); return value; };
const address = (value, label) => { if (typeof value !== 'string' || !isAddress(value, { strict: false }) || same(value, zeroAddress)) fail(`${label}: enter a nonzero EVM address.`); return value.toLowerCase(); };
const ceilDiv = (a, b) => (a + b - 1n) / b;
/** Equal supply slices; 10^27 is not divisible by 3, so three markets burn nothing and mint 1 base unit less. */
export const advancedSupply = count => FULL_SUPPLY - FULL_SUPPLY % BigInt(count);

export function advancedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide advanced launch settings.');
  const allowed = ['account', 'name', 'symbol', 'imageCid', 'milestoneUsd', 'feeBps', 'creatorBps', 'markets', 'recipients', 'vestDays', 'cliffDays'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`Unsupported advanced setting: ${key}.`);
  const text = (key, max) => { if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) fail(`${key}: required, maximum ${max} characters.`); return input[key].trim(); };
  const name = text('name', 64), symbol = text('symbol', 12);
  if (!/^[\x20-\x7e]+$/.test(name) || !/[A-Za-z0-9]/.test(name) || !/^[A-Za-z0-9]{1,12}$/.test(symbol)) fail('Use a printable name and an alphanumeric ticker.');
  const account = address(input.account, 'Wallet');
  const imageCid = text('imageCid', 100), image = cidToBytes32(imageCid);
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafkrei[a-z2-7]{52}|bafybei[a-z2-7]{52})$/.test(imageCid) || !image.ok || image.digest === ZERO_BYTES32) fail('Provide an IPFS sha2-256 image CID (Qm…, bafybei… or bafkrei…).');
  const milestoneUsd = input.milestoneUsd ?? '40000';
  if (usdAmount(milestoneUsd) <= 250000n) fail('Milestone must exceed $2,500.');
  const feeBps = integer(input.feeBps ?? 200, 101, 1000, 'Trading fee (bps)'), creatorBps = integer(input.creatorBps ?? 10000, 0, 10000, 'Creator share (bps)');
  if (!Array.isArray(input.markets) || input.markets.length < 1 || input.markets.length > 4) fail('Choose one to four quote markets.');
  const markets = input.markets.map((m, i) => {
    if (!m || typeof m !== 'object' || Object.keys(m).some(k => !['quote', 'openingBuy'].includes(k))) fail(`Market ${i + 1}: provide quote and openingBuy only.`);
    const quote = QUOTES.find(q => same(q.address, m.quote) && !q.native);
    if (!quote) fail(`Market ${i + 1}: choose a configured ERC-20 quote. Native ETH is not a quote token.`);
    const buy = typeof m.openingBuy === 'string' ? m.openingBuy.trim() : '';
    if (!/^\d{1,30}(\.\d{1,18})?$/.test(buy) || (buy.split('.')[1]?.length ?? 0) > quote.decimals || parseUnits(buy, quote.decimals) <= 0n)
      fail(`Market ${i + 1}: enter a positive opening purchase within ${quote.symbol} precision.`);
    return { quote: quote.address, openingBuy: buy };
  }).sort((a, b) => a.quote < b.quote ? -1 : 1);
  if (new Set(markets.map(m => m.quote)).size !== markets.length) fail('Each quote market must be unique.');
  let recipients = input.recipients ?? (creatorBps ? [{ address: account, bps: 10000 }] : []);
  if (!Array.isArray(recipients) || recipients.length > 50) fail('Use at most 50 fee recipients.');
  recipients = recipients.map((r, i) => {
    if (!r || typeof r !== 'object' || Object.keys(r).some(k => !['address', 'bps'].includes(k))) fail(`Recipient ${i + 1}: provide address and bps only.`);
    return { address: address(r.address, `Recipient ${i + 1}`), bps: integer(r.bps, 1, 10000, `Recipient ${i + 1} share (bps)`) };
  });
  if (new Set(recipients.map(r => r.address)).size !== recipients.length) fail('Fee recipients must be unique.');
  if (creatorBps === 0 && recipients.length) fail('Recipients require a nonzero creator share.');
  if (creatorBps !== 0 && (!recipients.length || recipients.reduce((sum, r) => sum + r.bps, 0) !== 10000)) fail('Recipient shares must total exactly 10,000 bps (100%).');
  const vestDays = input.vestDays == null ? 0 : integer(input.vestDays, 0, 3650, 'Vesting (days)');
  const cliffDays = input.cliffDays == null ? 0 : integer(input.cliffDays, 0, 3650, 'Cliff (days)');
  if ((vestDays !== 0 && vestDays < 7) || cliffDays > vestDays) fail('Vesting is off (0) or at least 7 days, with a cliff no longer than vesting.');
  return { account, name, symbol, imageCid, milestoneUsd, feeBps, creatorBps, markets, recipients, vestDays, cliffDays };
}

export function buildAdvancedParams(input, prices, salt) {
  const n = BigInt(input.markets.length), supply = advancedSupply(input.markets.length);
  if (supply % n !== 0n) fail('Supply must divide evenly by the market count.');
  return {
    name: input.name, symbol: input.symbol, supply, vestDuration: BigInt(input.vestDays * 86400), vestCliff: BigInt(input.cliffDays * 86400),
    capToleranceBps: CAP_TOLERANCE_BPS, salt, minShareForQueue: parseUnits('1000', 18),
    metadata: { imageCid: cidToBytes32(input.imageCid).digest, bannerCid: ZERO_BYTES32, infoCid: ZERO_BYTES32 },
    markets: input.markets.map(m => {
      const quote = QUOTES.find(q => q.address === m.quote), price = prices[m.quote];
      // Each pool values its own supply slice; the shared $2,500 FDV is divided before quoting.
      return { pair: m.quote, openingMarketCap: ceilDiv(BigInt(price.openingQuoteRaw), n), graduationThreshold: ceilDiv(BigInt(price.milestoneQuoteRaw), n),
        devBuyPairAmount: parseUnits(m.openingBuy, quote.decimals), minPushPayout: 1n, tickSpacing: TICK_SPACING, feeBps: input.feeBps,
        sellFeeBps: 0, burnBps: 0, creatorBps: input.creatorBps, openingWindow: 0, openingFeeBps: 0 };
    }),
    recipients: input.recipients.map(r => r.address), sharesBps: input.recipients.map(r => r.bps),
  };
}

const revertName = error => error?.walk?.(e => e?.data?.errorName)?.data?.errorName ?? error?.data?.errorName;
function contractError(error, action) {
  const name = revertName(error);
  if (name === 'DuplicateLaunch') fail('An identical name, ticker and economics already launched through the advanced factory.');
  if (name) fail(`Advanced factory rejected ${action} (${name}).`);
  throw error;
}

export class AdvancedLaunchService {
  constructor({ store, client = publicClient(), profilePath = process.env.PLUGGED_ADVANCED_PROFILE || null, now = Date.now, price = usdValuation,
    artifacts = null, loadProfile = loadDeploymentProfile, verifyProfile = verifyDeploymentProfile } = {}) {
    Object.assign(this, { store, client, profilePath, now, price, loadProfile, verifyProfile });
    this.artifactPromise = artifacts ? Promise.resolve(artifacts) : null;
    this.statusCache = null;
  }
  artifacts() { return this.artifactPromise ??= loadAdvancedArtifacts().catch(error => { this.artifactPromise = null; throw error; }); }
  /** Loads and fully verifies the advanced profile. No verified profile means no transaction. */
  async deployment(blockNumber) {
    if (!this.profilePath) fail('No advanced deployment profile is configured. Advanced launch is unavailable.');
    let profile;
    try { profile = await this.loadProfile({ profilePath: this.profilePath }); }
    catch (error) { fail(`Advanced deployment profile is invalid: ${error.message}`); }
    if (profile.engine !== ADVANCED_ENGINE) fail('Configured profile is not a plugged-advanced-v1 deployment.');
    let verified;
    try { verified = await this.verifyProfile(profile, { client: this.client, blockNumber }); }
    catch (error) { fail(`Advanced deployment verification failed: ${error.advanced ? error.message : error.shortMessage ?? error.message}`); }
    if (!verified?.verified || verified.engine !== ADVANCED_ENGINE || !verified.capabilities?.strictWalletCap) fail('Advanced deployment is not verified.');
    return verified;
  }
  async status() {
    if (this.statusCache && this.now() - this.statusCache.at < 30000) return this.statusCache.value;
    let value;
    try {
      const [profile] = await Promise.all([this.deployment(), this.artifacts()]);
      value = { engine: ADVANCED_ENGINE, available: true, reason: null, capabilities: profile.capabilities, verifiedBlock: profile.verifiedBlock,
        factory: profile.deployment.factory, launchRegistry: profile.deployment.launchRegistry, capToleranceBps: CAP_TOLERANCE_BPS, maxWalletBps: 300 };
    } catch (error) {
      value = { engine: ADVANCED_ENGINE, available: false, reason: error.advanced || /artifact/.test(error.message) ? error.message : 'Advanced deployment could not be verified.' };
    }
    this.statusCache = { at: this.now(), value };
    return value;
  }
  async prepare(raw) {
    const input = advancedInput(raw);
    if (!this.profilePath) fail('No advanced deployment profile is configured. Advanced launch is unavailable.');
    const blockNumber = await this.client.getBlockNumber();
    const [profile, artifacts] = await Promise.all([this.deployment(blockNumber), this.artifacts()]);
    if (input.markets.length > profile.capabilities.maxPools || input.recipients.length > profile.capabilities.maxRecipients) fail('Settings exceed this deployment’s capabilities.');
    const d = profile.deployment;
    const read = (target, abi, functionName, args = []) => this.client.readContract({ address: target, abi, functionName, args, blockNumber });
    const markets = await Promise.all(input.markets.map(async m => {
      const quote = QUOTES.find(q => q.address === m.quote);
      const [approved, config, decimals, balance, allowance, minimum] = await Promise.all([
        read(d.pairRegistry, REGISTRY_ABI, 'isApproved', [m.quote]), read(d.pairRegistry, REGISTRY_ABI, 'pairConfig', [m.quote]),
        read(m.quote, erc20Abi, 'decimals'), read(m.quote, erc20Abi, 'balanceOf', [input.account]),
        read(m.quote, erc20Abi, 'allowance', [input.account, d.factory]), read(d.factory, ADVANCED_FACTORY_ABI, 'minDevBuyFor', [m.quote]),
      ]);
      if (!approved) fail(`${quote.symbol} is not approved in this deployment’s pair registry.`);
      if (Number(decimals) !== quote.decimals || Number(config.tokenDecimals) !== quote.decimals) fail(`${quote.symbol} decimals differ from the catalog or registry. Operator correction required.`);
      const price = await this.price(m.quote, input.milestoneUsd, { useCache: false });
      if (price.quote !== m.quote || price.decimals !== quote.decimals || price.openingMarketCapUsd !== '2500' || Date.parse(price.expiresAt) <= this.now()) fail(`Fresh USD conversion is unavailable for ${quote.symbol}.`);
      return { quote: m.quote, symbol: quote.symbol, decimals: quote.decimals, balance, allowance, minimum, price };
    }));
    const prices = Object.fromEntries(markets.map(m => [m.quote, m.price]));
    const params = buildAdvancedParams(input, prices, `0x${randomBytes(32).toString('hex')}`);
    params.markets.forEach((m, i) => {
      const limit = m.openingMarketCap * 200n / 10000n;
      if (m.devBuyPairAmount < markets[i].minimum || m.devBuyPairAmount > limit) fail(`${markets[i].symbol} opening purchase must be between the factory minimum and 2% of its pool’s opening value (Plugged’s creator bound).`);
      if (m.graduationThreshold <= m.openingMarketCap) fail('Milestone must exceed the opening value in every pool.');
    });
    let settings, canonical, key, existing, predicted;
    try {
      [settings, predicted, canonical] = await Promise.all([
        read(d.factory, ADVANCED_FACTORY_ABI, 'economicsHash', [params]), read(d.factory, ADVANCED_FACTORY_ABI, 'predictTokenAddressFor', [input.account, params.salt]),
        Promise.all([read(d.launchRegistry, LAUNCH_REGISTRY_ABI, 'canonicalName', [params.name]), read(d.launchRegistry, LAUNCH_REGISTRY_ABI, 'canonicalTicker', [params.symbol])]),
      ]);
      key = await read(d.launchRegistry, LAUNCH_REGISTRY_ABI, 'fingerprint', [params.symbol, params.name, settings]);
      existing = await read(d.launchRegistry, LAUNCH_REGISTRY_ABI, 'tokenFor', [key]);
    } catch (error) { contractError(error, 'these settings'); }
    const fingerprint = `advanced:${key.toLowerCase()}`;
    if (!same(existing, zeroAddress) || this.store.duplicate(fingerprint)) fail('An identical name, ticker and economics already launched through the advanced factory.');
    const data = encodeAdvancedLaunch(params, artifacts);
    const transaction = { from: input.account, to: d.factory.toLowerCase(), chainId: NETWORK.hexId, value: '0x0', data };
    let next = 'launch', approvals = [], simulation = null;
    if (markets.some((m, i) => m.balance < params.markets[i].devBuyPairAmount)) next = 'fund';
    else {
      for (const [i, m] of markets.entries()) {
        const required = params.markets[i].devBuyPairAmount;
        if (m.allowance >= required) continue;
        // Reset nonzero allowances first, compatible with USDT-style quotes.
        const amount = m.allowance > 0n ? 0n : required;
        const sim = await this.client.simulateContract({ account: input.account, address: m.quote, abi: erc20Abi, functionName: 'approve', args: [d.factory, amount] });
        if (sim.result !== true) fail(`${m.symbol} refused approval.`);
        approvals.push({ quote: m.quote, symbol: m.symbol, reset: amount === 0n, amount: amount.toString(),
          transaction: { from: input.account, to: m.quote, chainId: NETWORK.hexId, value: '0x0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.factory, amount] }) } });
      }
      if (approvals.length) next = 'approve';
      else {
        try {
          const { result } = await this.client.simulateContract({ account: input.account, address: d.factory, abi: ADVANCED_FACTORY_ABI, functionName: 'launch', args: [params] });
          if (!same(result[0], predicted)) fail('Simulated token address differs from prediction.');
          const gas = await this.client.estimateContractGas({ account: input.account, address: d.factory, abi: ADVANCED_FACTORY_ABI, functionName: 'launch', args: [params] });
          transaction.gas = toHex(gas * 120n / 100n);
          simulation = { token: result[0].toLowerCase(), priceableMarkets: Number(result[1]), gas: gas.toString() };
        } catch (error) { if (error.advanced) throw error; contractError(error, 'the launch simulation'); }
      }
    }
    const sliceSupply = params.supply / BigInt(params.markets.length);
    const createdAt = this.now(), expiresAt = Math.min(...markets.map(m => Date.parse(m.price.expiresAt)));
    const record = jsonSafe({ id: randomUUID(), engine: ADVANCED_ENGINE, fingerprint, identityKey: key.toLowerCase(), settings, status: 'prepared', createdAt, expiresAt,
      preparedBlock: blockNumber, deployment: { factory: d.factory.toLowerCase(), launchRegistry: d.launchRegistry.toLowerCase(), verifiedBlock: profile.verifiedBlock },
      input, params, transaction, approvals, simulation, predicted: predicted.toLowerCase(), canonical: { name: canonical[0], symbol: canonical[1] },
      markets: markets.map((m, i) => ({ quote: m.quote, symbol: m.symbol, decimals: m.decimals, balance: m.balance, allowance: m.allowance,
        required: params.markets[i].devBuyPairAmount, minimum: m.minimum, priceUsd: m.price.priceUsd,
        opening: openingPoint(sliceSupply, params.markets[i].openingMarketCap, predicted.toLowerCase() < m.quote, TICK_SPACING) })),
      next });
    if (record.expiresAt <= createdAt) fail('Price expired during preparation. Retry.');
    this.store.prune(createdAt); this.store.save(record);
    return this.view(record);
  }
  view(record) {
    return { ...record, transaction: record.next === 'launch' && record.status === 'prepared' ? record.transaction : null,
      approvals: record.next === 'approve' && record.status === 'prepared' ? record.approvals : [],
      notes: ['Funding, each approval and the launch are separate wallet transactions.', 'Every quote pool receives an equal supply slice; the $2,500 opening value is divided across pools.',
        'The 3% wallet cap is enforced by the token for every address, including the creator and vesting vault. It limits each address, not a person using several addresses.',
        'Duplicate rejection covers canonical name, ticker and the factory’s economics hash. Live-priced opening values are part of that hash.',
        'USD prices are provider estimates, not a guaranteed USD peg. The factory has no launch deadline.'] };
  }
  get(id) { const record = this.store.get(id); if (!record || record.engine !== ADVANCED_ENGINE) fail('Advanced launch preparation not found.'); return record; }
  async recordStatus(id) { const record = this.get(id); return record.txHash ? this.confirm(record) : this.view(record); }
  checkTransaction(record, tx) {
    if (!same(tx.from, record.input.account) || !same(tx.to, record.deployment.factory) || !same(tx.input, record.transaction.data) || BigInt(tx.value) !== 0n || Number(tx.chainId) !== 4663)
      fail('Transaction does not match the prepared wallet, factory, calldata, value or chain.');
    if (tx.blockNumber != null && BigInt(tx.blockNumber) < BigInt(record.preparedBlock)) fail('Transaction predates this preparation.');
  }
  async submit(id, txHash) {
    const record = this.get(id);
    if (!/^0x[0-9a-f]{64}$/i.test(txHash ?? '')) fail('Provide a transaction hash.');
    if (record.txHash && !same(record.txHash, txHash)) fail('A different transaction is already attached.');
    if (!record.simulation) fail('Launch was not simulated. Prepare it again after funding and approvals.');
    this.checkTransaction(record, await this.client.getTransaction({ hash: txHash }));
    if (!record.txHash) { record.txHash = txHash.toLowerCase(); record.status = 'submitted'; this.store.save(record); }
    return this.confirm(record);
  }
  async confirm(record) {
    if (record.engine !== ADVANCED_ENGINE) fail('Not an advanced launch record.');
    const profile = await this.deployment();
    if (!same(profile.deployment.factory, record.deployment.factory) || !same(profile.deployment.launchRegistry, record.deployment.launchRegistry))
      fail('Configured advanced deployment differs from the one this launch was prepared for.');
    let tx;
    try { tx = await this.client.getTransaction({ hash: record.txHash }); }
    catch (error) { if (error.name === 'TransactionNotFoundError') return this.view(record); throw error; }
    this.checkTransaction(record, tx);
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: record.txHash }); }
    catch (error) { if (error.name === 'TransactionReceiptNotFoundError') return this.view(record); throw error; }
    if (receipt.status !== 'success') { record.status = 'reverted'; this.store.save(record); return this.view(record); }
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber }), latest = await this.client.getBlockNumber();
    if (!same(block.hash, receipt.blockHash) || latest < receipt.blockNumber + 2n) { record.status = 'submitted'; this.store.save(record); return this.view(record); }
    const decode = (abi, from) => receipt.logs.filter(l => same(l.address, from)).flatMap(log => { try { return [decodeEventLog({ abi, data: log.data, topics: log.topics })]; } catch { return []; } });
    const factoryEvents = decode(ADVANCED_FACTORY_ABI, record.deployment.factory), p = record.params, n = p.markets.length;
    const launched = factoryEvents.filter(e => e.eventName === 'AdvancedLaunched'), opened = factoryEvents.filter(e => e.eventName === 'MarketOpened');
    const registered = decode(LAUNCH_REGISTRY_ABI, record.deployment.launchRegistry).filter(e => e.eventName === 'Registered');
    if (launched.length !== 1 || registered.length !== 1 || opened.length !== n) fail('Expected one advanced launch, one identity registration and one market event per quote.');
    const e = launched[0].args, r = registered[0].args;
    if (!same(e.token, record.predicted) || !same(e.creator, record.input.account) || !same(e.economics, record.settings) || Number(e.marketCount) !== n)
      fail('Advanced launch event differs from the prepared launch.');
    if (!same(r.key, record.identityKey) || !same(r.token, record.predicted) || !same(r.settingsHash, record.settings) || r.name !== record.canonical.name || r.ticker !== record.canonical.symbol)
      fail('Identity registration differs from the prepared launch.');
    if (opened.some((o, i) => !same(o.args.token, record.predicted) || !same(o.args.pair, p.markets[i].pair))) fail('Market events differ from the prepared quotes.');
    const at = receipt.blockNumber, read = (target, abi, functionName, args = []) => this.client.readContract({ address: target, abi, functionName, args, blockNumber: at });
    const token = record.predicted, poolIds = opened.map(o => o.args.poolId.toLowerCase());
    const [ours, pools, pairs, owner, name, symbol, supply, cap, ledger] = await Promise.all([
      read(record.deployment.factory, ADVANCED_FACTORY_ABI, 'isOurs', [token]), read(record.deployment.factory, ADVANCED_FACTORY_ABI, 'poolsOf', [token]),
      read(record.deployment.factory, ADVANCED_FACTORY_ABI, 'pairsOf', [token]), read(record.deployment.launchRegistry, LAUNCH_REGISTRY_ABI, 'tokenFor', [record.identityKey]),
      read(token, ADVANCED_TOKEN_ABI, 'name'), read(token, ADVANCED_TOKEN_ABI, 'symbol'), read(token, ADVANCED_TOKEN_ABI, 'totalSupply'),
      read(token, ADVANCED_TOKEN_ABI, 'MAX_WALLET_BPS'), read(record.deployment.factory, ADVANCED_FACTORY_ABI, 'ledgerOf', [token]),
    ]);
    if (!ours || !same(owner, token) || pools.length !== n || pools.some((id, i) => !same(id, poolIds[i])) || pairs.length !== n || pairs.some((pair, i) => !same(pair, p.markets[i].pair))
      || name !== record.canonical.name || symbol !== record.canonical.symbol || BigInt(supply) !== BigInt(p.supply) || Number(cap) !== 300 || !same(ledger, e.ledger))
      fail('On-chain pools or identity differ from the launch receipt.');
    const duplicate = this.store.duplicate(record.fingerprint);
    Object.assign(record, { status: duplicate && duplicate !== record.id ? 'duplicate' : 'confirmed', token, poolIds, ledger: e.ledger.toLowerCase(),
      priceableMarkets: Number(e.priceableMarkets), blockNumber: at.toString(), blockHash: receipt.blockHash, launchedAt: Number(block.timestamp) });
    this.store.save(record);
    return this.view(record);
  }
  async reconcile() {
    let failed = false;
    for (const record of (this.store.listForReconcile ? this.store.listForReconcile('submitted', 20, ADVANCED_ENGINE) : this.store.list('submitted', 20, ADVANCED_ENGINE))) {
      try { await this.confirm(record); } catch { failed = true; }
      try { this.store.checked?.(record.id, Date.now()); } catch {}
    }
    return !failed;
  }
}
