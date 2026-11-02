import { createPublicClient, http } from '../../app/node_modules/viem/_esm/index.js';
import { loadDeploymentProfile, verifyDeploymentProfile } from '../lib/deployment-profile.mjs';

// Read-only live baseline check. Deliberately separate from hermetic unit tests.
const client = createPublicClient({ transport: http(process.env.PLUGGED_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', { timeout: 30000, retryCount: 1 }) });
const profile = await verifyDeploymentProfile(await loadDeploymentProfile(), { client });
console.log(JSON.stringify({ engine: profile.engine, verified: profile.verified, blockNumber: profile.verifiedBlock,
  ownerAddress: profile.ownerAddress, platformRecipientAddress: profile.platformRecipientAddress,
  codeHashesVerified: Object.keys(profile.hashes).length, capabilities: profile.capabilities }, null, 2));
