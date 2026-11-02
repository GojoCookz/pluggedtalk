import { NETWORK, POLICY, QUOTES } from './config.mjs';
import { SOCIAL_HOSTS, httpsUrl, validatePrograms } from './programs.mjs';
import { launchFingerprint } from './fingerprint.mjs';
import { validateEconomics } from './economics.mjs';
import { validateRecipients } from './recipients.mjs';

export function validatePlan(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Provide a launch draft.'] };
  const text = (key, max, required = false) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
      errors.push(`${key}: ${required ? 'required; ' : ''}maximum ${max} characters.`);
      return '';
    }
    return value.trim();
  };
  const name = text('name', 64, true);
  const symbol = text('symbol', 12, true);
  if (!/^[A-Za-z0-9]{1,12}$/.test(symbol)) errors.push('symbol: use 1–12 letters or numbers.');
  const description = text('description', 500);
  const github = text('github', 200);
  if (github && !/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+\/?$/.test(github)) errors.push('github: use a github.com/owner/repository URL.');
  const website = text('website', 300);
  if (website) {
    try { const url = new URL(website); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { errors.push('website: use a public HTTPS URL without credentials.'); }
  }
  if (input.chainId !== NETWORK.id) errors.push('chainId: select Robinhood Chain (4663).');
  if (input.maxWalletBps !== POLICY.maxWalletBps) errors.push('maxWalletBps: Plugged plans require 300 BPS (3%).');
  const quote = QUOTES.find(q => q.address === String(input.quote || '').toLowerCase());
  if (!quote) errors.push('quote: choose a supported crypto asset by contract address.');
  const holderBps = input.holderBps;
  if (!Number.isInteger(holderBps) || holderBps < 0 || holderBps > 10000) errors.push('holderBps: enter 0–10000 basis points.');
  const rewards = input.rewards ?? { developerEnabled: holderBps < 10000, communityEnabled: holderBps > 0 };
  if (!rewards || typeof rewards.developerEnabled !== 'boolean' || typeof rewards.communityEnabled !== 'boolean'
    || (!rewards.developerEnabled && !rewards.communityEnabled)) errors.push('rewards: enable developer or community rewards.');
  if (rewards?.developerEnabled === false && holderBps !== 10000) errors.push('rewards: community must receive 100% when developer rewards are off.');
  if (rewards?.communityEnabled === false && holderBps !== 0) errors.push('rewards: developer must receive 100% when community rewards are off.');
  if (rewards?.communityEnabled && holderBps === 0 || rewards?.developerEnabled && holderBps === 10000) errors.push('rewards: enabled recipients require a positive share.');
  const socials = {};
  if (input.socials !== undefined && (!input.socials || typeof input.socials !== 'object' || Array.isArray(input.socials))) errors.push('socials: invalid configuration.');
  for (const [key, hosts] of Object.entries(SOCIAL_HOSTS)) {
    const link = input.socials?.[key] ?? '';
    if (link !== '' && !httpsUrl(link, hosts)) errors.push(`${key}: enter an HTTPS profile/invite URL on ${hosts.join(' or ')}.`);
    socials[key] = typeof link === 'string' ? link.trim() : '';
  }
  const programs = validatePrograms(input.programs, quote?.decimals ?? 18);
  errors.push(...programs.errors);
  const economics = validateEconomics(input.economics, quote ?? {decimals:18,address:''}, QUOTES);
  errors.push(...economics.errors);
  const recipientResult=validateRecipients(input.recipients,rewards?.developerEnabled!==false,POLICY.maxRecipients);
  errors.push(...recipientResult.errors);
  const recipients=recipientResult.recipients;
  if (errors.length) return { ok: false, errors };
  const value = {
    schema: POLICY.schema, chainId: NETWORK.id, name, symbol, description, github, website,
    quote: quote.address, maxWalletBps: POLICY.maxWalletBps, totalSupply: POLICY.totalSupply,
    holderBps, recipients, rewards: { developerEnabled: rewards.developerEnabled, communityEnabled: rewards.communityEnabled },
    socials, programs: programs.value, economics: economics.value, status: 'draft',
  };
  value.antiVamp = launchFingerprint(value, quote.decimals);
  return { ok: true, value };
}

// This previews allocation of an ALREADY FUNDED recipient pool, not total trading fees.
// Rounding is identical to PluggedFeeSplitter.claimable: floor, with dust retained.
export function splitAmount(amount, recipients) {
  if (typeof amount !== 'bigint' || amount < 0n) throw new Error('Amount must be nonnegative base units.');
  if (!Array.isArray(recipients) || !recipients.length || recipients.some(r => !Number.isInteger(r.bps) || r.bps <= 0 || r.bps > 10000)
      || recipients.reduce((s, r) => s + r.bps, 0) !== 10000) throw new Error('Invalid allocation.');
  const shares = recipients.map(r => ({ ...r, amount: amount * BigInt(r.bps) / 10000n }));
  return { shares, retained: amount - shares.reduce((sum, r) => sum + r.amount, 0n) };
}
