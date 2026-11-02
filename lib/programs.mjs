import { isAddress, getAddress, parseUnits } from '../../app/node_modules/viem/_esm/index.js';

export const SOCIAL_HOSTS = Object.freeze({
  x: ['x.com', 'twitter.com'], telegram: ['t.me'], discord: ['discord.gg', 'discord.com'],
  farcaster: ['farcaster.xyz', 'warpcast.com'], youtube: ['youtube.com', 'www.youtube.com', 'youtu.be'],
});
export const blankPrograms = () => ({
  fundraising: { enabled: false, beneficiary: '', goal: '', deadline: '' },
  refunds: { enabled: false, trigger: 'goal-not-met-at-deadline' },
  cashback: { enabled: false, feeRebateBps: 1000, budget: '' },
  charity: { enabled: false, name: '', website: '' },
});

export function httpsUrl(value, hosts) {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (!hosts || hosts.includes(url.hostname)) && (!hosts || url.pathname.length > 1);
  } catch { return false; }
}

export function validatePrograms(raw, decimals) {
  const errors = [];
  if (raw === undefined) return { value: blankPrograms(), errors };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['programs: invalid configuration.'] };
  const value = blankPrograms();
  for (const key of Object.keys(value)) {
    if (!raw[key] || typeof raw[key].enabled !== 'boolean') errors.push(`${key}: set enabled to true or false.`);
    value[key].enabled = raw[key]?.enabled === true;
  }
  const positiveAmount = (amount, field) => {
    if (typeof amount !== 'string' || !/^\d{1,40}(\.\d{1,18})?$/.test(amount) || (amount.split('.')[1]?.length ?? 0) > decimals) {
      errors.push(`${field}: enter a positive amount with up to ${decimals} decimal places.`); return '';
    }
    const units = parseUnits(amount, decimals);
    if (units <= 0n || units >= 2n ** 256n) errors.push(`${field}: amount outside supported range.`);
    return amount;
  };
  if (value.fundraising.enabled) {
    const f = raw.fundraising;
    if (typeof f.beneficiary !== 'string' || !isAddress(f.beneficiary) || /^0x0{40}$/i.test(f.beneficiary)) errors.push('fundraising: a nonzero beneficiary wallet is required.');
    else value.fundraising.beneficiary = getAddress(f.beneficiary);
    value.fundraising.goal = positiveAmount(f.goal, 'fundraising goal');
    // Past drafts remain editable. Submission must recheck deadline against chain time.
    if (typeof f.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(f.deadline)
      || !Number.isFinite(Date.parse(f.deadline)) || new Date(f.deadline).toISOString() !== f.deadline) errors.push('fundraising: choose a valid UTC deadline.');
    else value.fundraising.deadline = f.deadline;
  }
  if (value.refunds.enabled !== value.fundraising.enabled || (value.refunds.enabled && raw.refunds.trigger !== value.refunds.trigger)) {
    errors.push('refunds: fundraising requires contributor refunds when the goal is missed at the deadline.');
  }
  if (value.cashback.enabled) {
    const c = raw.cashback;
    if (!Number.isInteger(c.feeRebateBps) || c.feeRebateBps <= 0 || c.feeRebateBps > 10000) errors.push('cashback: rebate must be 0.01–100% of eligible paid fees.');
    else value.cashback.feeRebateBps = c.feeRebateBps;
    value.cashback.budget = positiveAmount(c.budget, 'cashback budget');
  }
  if (value.charity.enabled) {
    if (!value.fundraising.enabled) errors.push('charity: enable fundraising and specify its beneficiary wallet.');
    if (typeof raw.charity.name !== 'string' || !raw.charity.name.trim() || raw.charity.name.length > 100) errors.push('charity: enter an organization name (up to 100 characters).');
    else value.charity.name = raw.charity.name.trim();
    if (!httpsUrl(raw.charity.website)) errors.push('charity: enter an HTTPS organization website.');
    else value.charity.website = raw.charity.website;
  }
  return { value, errors };
}
