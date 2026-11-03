// Locale registry and lookup. Strings live in web/locales/<code>.js; English is bundled and is
// the fallback for any key a locale lacks. Other locales load on demand as static files.
import en from './locales/en.js';
import { LOCALES, LOCALE_CODES } from '../lib/locales.mjs';

export { LOCALES, LOCALE_CODES };
// Add right-to-left language subtags here when such a locale ships.
const RTL = new Set([]);
export const direction = code => RTL.has(String(code).split('-')[0]) ? 'rtl' : 'ltr';

const tables = { en };
export const isLoaded = code => Boolean(tables[code]);
export function registerLocale(code, table) { if (LOCALE_CODES.includes(code)) tables[code] = table; }
/** Loads a locale table once; resolves false when it cannot be fetched (English keeps working). */
export async function loadLocale(code, base = globalThis.document?.baseURI) {
  if (!LOCALE_CODES.includes(code)) return false;
  if (tables[code]) return true;
  try { const path = new URL(`locales/${code}.js`, base).href; tables[code] = (await import(path)).default; return true; }
  catch { return false; }
}

/** Picks the best supported locale for a list such as navigator.languages. */
export function matchLanguage(preferred = []) {
  const lower = LOCALE_CODES.map(c => c.toLowerCase());
  for (const raw of preferred) {
    const tag = String(raw || '').toLowerCase();
    const exact = lower.indexOf(tag);
    if (exact !== -1) return LOCALE_CODES[exact];
    const base = tag.split('-')[0];
    if (base === 'zh' && /-(tw|hk|mo|hant)/.test(tag)) continue;
    const partial = LOCALE_CODES.find(c => c.toLowerCase().split('-')[0] === base);
    if (partial) return partial;
  }
  return 'en';
}

export function translate(code, key, args) {
  let text = tables[code]?.[key] ?? en[key] ?? key;
  if (args) text = text.replace(/\{(\w+)\}/g, (m, name) => (args[name] ?? m));
  return text;
}

// Known server error messages (advanced launch + fee vault). Patterns are anchored; captured
// groups ({1}, {2}, …) carry addresses, numbers or symbols through unchanged. Unknown messages,
// and every message in English, are returned as the raw server text.
const SERVER_ERRORS = [
  [/^(.+): enter a nonzero EVM address\.$/, 'serverError.001'],
  [/^Provide a JSON object\.$/, 'serverError.002'],
  [/^Unsupported vault input: (.+)\.$/, 'serverError.003'],
  [/^Provide a container ID\.$/, 'serverError.004'],
  [/^Select chain (\d+)\.$/, 'serverError.005'],
  [/^Vault RPC must be chain (\d+)\.$/, 'serverError.006'],
  [/^Fee vault is not deployed or not configured on this server\.$/, 'serverError.007'],
  [/^Fee vault RPC is unavailable\.$/, 'serverError.008'],
  [/^Fee vault deployment verification failed\. Actions are disabled\.$/, 'serverError.009'],
  [/^Vault balance is below recorded credits\. Actions are disabled pending investigation\.$/, 'serverError.010'],
  [/^Unknown vault action\.$/, 'serverError.011'],
  [/^Only extend accepts a deadline\.$/, 'serverError.012'],
  [/^This wallet cannot perform that action on this container now\. Refresh\.$/, 'serverError.013'],
  [/^Provide the new deadline as a Unix timestamp\.$/, 'serverError.014'],
  [/^New deadline must be later than the current one and within 365 days\.$/, 'serverError.015'],
  [/^Simulation amount differs from the vault balance\. Refresh\.$/, 'serverError.016'],
  [/^Provide a transaction hash\.$/, 'serverError.017'],
  [/^Preparation not found for this wallet\.$/, 'serverError.018'],
  [/^Transaction is not a vault call from this wallet\.$/, 'serverError.019'],
  [/^Transaction differs from the prepared calldata\.$/, 'serverError.020'],
  [/^Transaction is not a vault action\.$/, 'serverError.021'],
  [/^Receipt does not match the submitted transaction\.$/, 'serverError.022'],
  [/^Expected exactly one matching vault event in the receipt\.$/, 'serverError.023'],
  [/^Claim event does not pay this wallet\.$/, 'serverError.024'],
  [/^Event recipient differs from signer\.$/, 'serverError.025'],
  [/^Container window: use whole days from 7 to 365\.$/, 'serverError.026'],
  [/^Container currency must be ETH or a token contract\.$/, 'serverError.027'],
  [/^The container recipient must differ from the creating wallet\.$/, 'serverError.028'],
  [/^Created container differs from the signed request\.$/, 'serverError.029'],
  [/^Simulation differs from the vault container count\. Refresh\.$/, 'serverError.030'],
  [/^Vault rejected (\w+) \((\w+)\)\.$/, 'serverError.031'],
  [/^(.+) signing is disabled by the operator\.$/, 'serverError.032'],
  [/^Invalid preparation ID\.$/, 'serverError.033'],
  [/^Unsupported request fields\.$/, 'serverError.034'],
  [/^Provide advanced launch settings\.$/, 'serverError.035'],
  [/^Unsupported advanced setting: (.+)\.$/, 'serverError.036'],
  [/^(\w+): required, maximum (\d+) characters\.$/, 'serverError.037'],
  [/^(.+): use an integer from (\d+) to (\d+)\.$/, 'serverError.038'],
  [/^Use a printable name and an alphanumeric ticker\.$/, 'serverError.039'],
  [/^Provide an IPFS sha2-256 image CID .*$/, 'serverError.040'],
  [/^Milestone must exceed \$2,500\.$/, 'serverError.041'],
  [/^Choose one to four quote markets\.$/, 'serverError.042'],
  [/^Market (\d+): provide quote and openingBuy only\.$/, 'serverError.043'],
  [/^Market (\d+): choose a configured ERC-20 quote\. Native ETH is not a quote token\.$/, 'serverError.044'],
  [/^Market (\d+): enter a positive opening purchase within (.+) precision\.$/, 'serverError.045'],
  [/^Each quote market must be unique\.$/, 'serverError.046'],
  [/^Use at most 50 fee recipients\.$/, 'serverError.047'],
  [/^This token is not a confirmed Plugged advanced launch\.$/, 'serverError.048'],
  [/^Choose one of this token's verified quote pools\.$/, 'serverError.049'],
  [/^Advanced markets require the advanced launch service\.$/, 'serverError.050'],
  [/^Advanced profile lacks hook, factory or pool manager roles\.$/, 'serverError.051'],
  [/^Launch was confirmed against a different advanced deployment\.$/, 'serverError.052'],
  [/^Factory no longer reports these pools\.$/, 'serverError.053'],
  [/^Pool identity does not match the verified launch\.$/, 'serverError.054'],
  [/^Hook pool configuration differs from the confirmed launch\.$/, 'serverError.055'],
  [/^Verification failed\.$/, 'serverError.056'],
  [/^Request failed\.$/, 'serverError.057'],
  [/^Recipient (\d+): provide address and bps only\.$/, 'serverError.058'],
  [/^Fee recipients must be unique\.$/, 'serverError.059'],
  [/^Recipients require a nonzero creator share\.$/, 'serverError.060'],
  [/^Recipient shares must total exactly 10,000 bps \(100%\)\.$/, 'serverError.061'],
  [/^Vesting is off \(0\) or at least 7 days, with a cliff no longer than vesting\.$/, 'serverError.062'],
  [/^Supply must divide evenly by the market count\.$/, 'serverError.063'],
  [/^An identical name, ticker and economics already launched through the advanced factory\.$/, 'serverError.064'],
  [/^Advanced factory rejected (\w+) \((\w+)\)\.$/, 'serverError.065'],
  [/^No advanced deployment profile is configured\. Advanced launch is unavailable\.$/, 'serverError.066'],
  [/^Advanced deployment profile is invalid: (.+)$/, 'serverError.067'],
  [/^Configured profile is not a plugged-advanced-v1 deployment\.$/, 'serverError.068'],
  [/^Advanced deployment verification failed: (.+)$/, 'serverError.069'],
  [/^Advanced deployment is not verified\.$/, 'serverError.070'],
  [/^Advanced deployment could not be verified\.$/, 'serverError.071'],
  [/^Settings exceed this deployment's capabilities\.$/, 'serverError.072'],
  [/^(.+) is not approved in this deployment's pair registry\.$/, 'serverError.073'],
  [/^(.+) decimals differ from the catalog or registry\. Operator correction required\.$/, 'serverError.074'],
  [/^Fresh USD conversion is unavailable for (.+)\.$/, 'serverError.075'],
  [/^(.+) opening purchase must be between the factory minimum and 2% of its pool's opening value .*$/, 'serverError.076'],
  [/^Milestone must exceed the opening value in every pool\.$/, 'serverError.077'],
  [/^(.+) refused approval\.$/, 'serverError.078'],
  [/^Simulated token address differs from prediction\.$/, 'serverError.079'],
  [/^Price expired during preparation\. Retry\.$/, 'serverError.080'],
  [/^Advanced launch preparation not found\.$/, 'serverError.081'],
  [/^Transaction does not match the prepared wallet, factory, calldata, value or chain\.$/, 'serverError.082'],
  [/^Transaction predates this preparation\.$/, 'serverError.083'],
  [/^A different transaction is already attached\.$/, 'serverError.084'],
  [/^Launch was not simulated\. Prepare it again after funding and approvals\.$/, 'serverError.085'],
  [/^Not an advanced launch record\.$/, 'serverError.086'],
  [/^Configured advanced deployment differs from the one this launch was prepared for\.$/, 'serverError.087'],
  [/^Expected one advanced launch, one identity registration and one market event per quote\.$/, 'serverError.088'],
  [/^Advanced launch event differs from the prepared launch\.$/, 'serverError.089'],
  [/^Identity registration differs from the prepared launch\.$/, 'serverError.090'],
  [/^Market events differ from the prepared quotes\.$/, 'serverError.091'],
  [/^On-chain pools or identity differ from the launch receipt\.$/, 'serverError.092'],
  [/^Simulation is not a payout guarantee\.$/, 'serverError.093'],
  [/^After acceptance the allocator can never reclaim this container\.$/, 'serverError.094'],
  [/^Funds move only to the fixed recipient or allocator\.$/, 'serverError.095'],
  [/^The inbox address is fixed for this preparation and belongs only to a container created by this wallet; the container id is final after confirmation\.$/, 'serverError.096'],
  [/^Unaccepted funds return to this wallet only after decline or expiry\.$/, 'serverError.097'],
  [/^Request failed\.?.*$/, 'serverError.098'],
];
/** Translate a known server error to the UI language; unknown text is returned unchanged. */
export function serverError(message, language) {
  const text = String(message ?? '');
  if (language === 'en' || !tables[language]) return text;
  for (const [pattern, key] of SERVER_ERRORS) {
    const m = text.match(pattern);
    if (!m) continue;
    const template = tables[language][key];
    return template ? template.replace(/\{(\d)\}/g, (_, n) => m[Number(n)] ?? '') : text;
  }
  return text;
}
export const SERVER_ERROR_KEYS = SERVER_ERRORS.map(([, key]) => key);
