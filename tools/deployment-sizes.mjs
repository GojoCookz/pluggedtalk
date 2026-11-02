import { readFile } from 'node:fs/promises';

// Foundry 1.5.1's --sizes exit gate is fixed to Ethereum EIP-170 even when the
// configured execution code_size_limit is Robinhood's 96 KiB. Gate both limits explicitly.
const names = ['PairRegistry', 'LaunchToken', 'FeeHook', 'Launcher', 'TradeRouter', 'MultiDeployer',
  'PluggedAdvancedToken', 'PluggedAdvancedFactory', 'PluggedAdvancedLedger', 'PluggedAdvancedFeed',
  'PluggedAdvancedSplitter', 'PluggedLaunchRegistry', 'PluggedFeeSplitter'];
const rows = [];
for (const name of names) {
  const artifact = JSON.parse(await readFile(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
  const bytes = key => {
    const hex = artifact[key]?.object;
    if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error(`Unlinked or missing ${key}: ${name}`);
    return (hex.length - 2) / 2;
  };
  const runtimeBytes = bytes('deployedBytecode'), initCodeBytes = bytes('bytecode');
  if (runtimeBytes > 98304 || initCodeBytes > 196608) throw new Error(`Robinhood deployment size exceeded: ${name}`);
  rows.push({ contract: name, runtimeBytes, initCodeBytes, ethereumEip170Compatible: runtimeBytes <= 24576 });
}
console.log(JSON.stringify({ chainId: 4663, runtimeLimit: 98304, initCodeLimit: 196608, passed: true, contracts: rows }, null, 2));
