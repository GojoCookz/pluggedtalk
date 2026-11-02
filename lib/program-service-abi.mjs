import { parseAbi } from '../../app/node_modules/viem/_esm/index.js';

const payment=['function CURRENCY() view returns (address)'];
export const CAMPAIGN_ABI=parseAbi([...payment,
  'function BENEFICIARY() view returns (address)','function GOAL() view returns (uint256)',
  'function DEADLINE() view returns (uint256)','function totalContributed() view returns (uint256)',
  'function totalRefunded() view returns (uint256)','function paid() view returns (bool)',
  'function contributions(address) view returns (uint256)','function contribute(uint256) payable',
  'function payout()','function refund(address)',
  'event Contributed(address indexed contributor,uint256 amount)',
  'event Refunded(address indexed contributor,uint256 amount)','event Paid(address indexed beneficiary,uint256 amount)',
]);
export const CASHBACK_ABI=parseAbi([...payment,
  'function ATTESTOR() view returns (address)','function REBATE_BPS() view returns (uint256)',
  'function BUDGET() view returns (uint256)','function totalFunded() view returns (uint256)',
  'function totalClaimed() view returns (uint256)','function claimed(address) view returns (uint256)',
  'function voucherDigest(address,uint256,uint256,bytes32) view returns (bytes32)',
  'function fund(uint256) payable','function claim(address,uint256,uint256,bytes32,bytes)',
  'event Funded(address indexed funder,uint256 amount)',
  'event Claimed(address indexed trader,uint256 amount,uint256 cumulativeFees,bytes32 evidence)',
]);
