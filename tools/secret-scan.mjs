// Content secret scan for release packages (audit L9). Reports file:line and rule, never the value.
// Public Anvil/Hardhat development keys are allowed: they are published test fixtures, not secrets.
const PUBLIC_DEV_KEYS = new Set([
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  'dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
]);
export const RULES = [
  { id: 'private-key', re: /(?:priv(?:ate)?[_-]?key|secret[_-]?key|PLUGGED_PRIVATE_KEY|DEPLOYER_KEY|signer[_-]?key)["'\s]*[:=]\s*["'`]?(?:0x)?([0-9a-fA-F]{64})\b/gi, value: 1 },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@'"`<>]+:[^\s/@'"`<>]+@[^\s'"`<>]+/gi },
  { id: 'rpc-api-key', re: /\b(?:alchemy\.com\/v2|infura\.io\/v3|quiknode\.pro)\/([A-Za-z0-9_-]{16,})/gi, value: 1 },
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { id: 'mnemonic', re: /\b(?:mnemonic|seed[_ -]?phrase)["'\s]*[:=]\s*["'`]?(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/gi },
];
const PLACEHOLDER = /example|placeholder|your[_-]?|<[^>]+>|\$\{|xxxx|redacted|user:pass@|USER:PASS@/i;

export function scanText(text, path = '') {
  const findings = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      const value = rule.value ? match[rule.value] : match[0];
      if (rule.id === 'private-key' && PUBLIC_DEV_KEYS.has(value.toLowerCase())) continue;
      if (rule.id === 'mnemonic' && /test test test test test test test test test test test junk/.test(match[0])) continue;
      if (rule.id === 'url-credentials' && PLACEHOLDER.test(match[0])) continue;
      if (rule.id === 'rpc-api-key' && PLACEHOLDER.test(value)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ path, line, rule: rule.id });
    }
  }
  return findings;
}

export const TEXT_FILE = /\.(mjs|js|ts|tsx|sol|md|json|html|css|svg|service|timer|example|toml|txt|env|ya?ml|sh|ps1)$|(^|\/)(Caddyfile|\.gitignore)$/i;
