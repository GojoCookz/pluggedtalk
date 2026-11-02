import indexedQuotes from '../data/quotes.json';
// Quote catalog is read-only research. Carbon's registry is not a Plugged deployment.
export const NETWORK = Object.freeze({
  id: 4663, hexId: '0x1237', name: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  launcher: null, // Plugged has no deployment. Never substitute Carbon's launcher.
});
export const QUOTES = Object.freeze([...indexedQuotes,{address:'0x0000000000000000000000000000000000000000',symbol:'ETH',name:'Native Ether',decimals:18,native:true,category:'native'}].sort((a,b) => {
  const priority = address => address === '0x0bd7d308f8e1639fab988df18a8011f41eacad73' ? 0 : address === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 1 : 2;
  return priority(a.address) - priority(b.address) || a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address);
}));
export const POLICY = Object.freeze({ maxWalletBps: 300, maxRecipients: 100, totalSupply: '1000000000', referralsEnabled: false,
  openingMarketCapUsd:'2500',defaultMilestoneMarketCapUsd:'40000',mechanism:'direct-v4',inputCurrency:'ETH',inputChainId:4663,
  migrationRequired:false,quotePolicy:'configured-address-catalog',schema: 'plugged.launch-draft.v2' });
