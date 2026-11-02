import { blankPrograms } from '../lib/programs.mjs';

export function rewardFields(d, t) {
  const r = d.rewards;
  return `<div class="reward-controls"><label class="toggle"><input type="checkbox" name="developerEnabled" ${r.developerEnabled ? 'checked' : ''}>${t('developerRewards')}</label>
    <label class="toggle"><input type="checkbox" name="communityEnabled" ${r.communityEnabled ? 'checked' : ''}>${t('communityRewards')}</label>
    <div class="fields"><label class="field">${t('developerRatio')}<input type="number" name="developerPercent" min="0" max="100" step="0.01" value="${(10000-d.holderBps)/100}" ${!r.developerEnabled || !r.communityEnabled ? 'readonly' : ''}></label>
    <label class="field">${t('communityRatio')}<input type="number" name="holderPercent" min="0" max="100" step="0.01" value="${d.holderBps/100}" ${!r.developerEnabled || !r.communityEnabled ? 'readonly' : ''}></label></div></div>`;
}

export function programFields(d, t, esc) {
  const p = d.programs ?? blankPrograms();
  const f = p.fundraising, c = p.cashback, charity = p.charity;
  return `<section class="form-section"><h2>${t('programsTitle')}</h2><p>${t('programsHint')}</p>
    <label class="toggle"><input name="fundraisingEnabled" type="checkbox" ${f.enabled?'checked':''}>${t('fundraising')}</label>
    <div class="program-fields" ${f.enabled?'':'hidden'}><div class="fields"><label class="field full">${t('beneficiary')}<input name="beneficiary" value="${esc(f.beneficiary)}" maxlength="42" placeholder="0x…" ${f.enabled?'required':'disabled'}></label>
    <label class="field">${t('fundingGoal')}<input name="fundingGoal" inputmode="decimal" value="${esc(f.goal)}" placeholder="1000" ${f.enabled?'required':'disabled'}></label>
    <label class="field">${t('deadlineUTC')}<input name="fundingDeadline" type="datetime-local" step="60" value="${esc(f.deadline.slice(0,16))}" ${f.enabled?'required':'disabled'}></label></div></div>
    <label class="toggle"><input type="checkbox" ${f.enabled?'checked':''} disabled>${t('failedGoalRefunds')}</label><p class="receipt-note">${t('refundHint')}</p>
    <label class="toggle"><input name="cashbackEnabled" type="checkbox" ${c.enabled?'checked':''}>${t('cashback')}</label>
    <div class="program-fields" ${c.enabled?'':'hidden'}><div class="fields"><label class="field">${t('cashbackRate')}<input name="cashbackPercent" type="number" min="0.01" max="100" step="0.01" value="${c.feeRebateBps/100}" ${c.enabled?'required':'disabled'}></label>
    <label class="field">${t('cashbackBudget')}<input name="cashbackBudget" inputmode="decimal" value="${esc(c.budget)}" placeholder="100" ${c.enabled?'required':'disabled'}></label></div><p class="receipt-note">${t('cashbackHint')}</p></div>
    <label class="toggle"><input name="charityEnabled" type="checkbox" ${charity.enabled?'checked':''}>${t('charity')}</label>
    <div class="program-fields" ${charity.enabled?'':'hidden'}><div class="fields"><label class="field">${t('charityName')}<input name="charityName" maxlength="100" value="${esc(charity.name)}" ${charity.enabled?'required':'disabled'}></label>
    <label class="field">${t('website')}<input name="charityWebsite" type="url" maxlength="300" value="${esc(charity.website)}" placeholder="https://" ${charity.enabled?'required':'disabled'}></label></div><p class="receipt-note">${t('charityHint')}</p></div></section>`;
}

export function captureOptions(fields, d, percentToBps) {
  d.rewards = { developerEnabled: fields.has('developerEnabled'), communityEnabled: fields.has('communityEnabled') };
  d.socials = Object.fromEntries(['x','telegram','discord','farcaster','youtube'].map(key=>[key,String(fields.get(`social-${key}`) ?? '')]));
  d.programs ??= blankPrograms();
  const p = d.programs;
  p.fundraising.enabled = fields.has('fundraisingEnabled'); p.refunds.enabled = p.fundraising.enabled;
  p.cashback.enabled = fields.has('cashbackEnabled'); p.charity.enabled = fields.has('charityEnabled');
  const assign = (target,key,name,convert=String) => { if(fields.has(name))target[key]=convert(fields.get(name)); };
  assign(p.fundraising,'beneficiary','beneficiary'); assign(p.fundraising,'goal','fundingGoal');
  assign(p.fundraising,'deadline','fundingDeadline',value=>value?`${value}:00.000Z`:'');
  assign(p.cashback,'budget','cashbackBudget'); assign(p.cashback,'feeRebateBps','cashbackPercent',percentToBps);
  assign(p.charity,'name','charityName'); assign(p.charity,'website','charityWebsite');
}
