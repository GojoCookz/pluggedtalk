import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createPublicClient, createWalletClient, decodeFunctionData, erc20Abi, getAddress, hashTypedData, http, keccak256, parseEther, toHex, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { mnemonicToAccount, privateKeyToAccount } from '../../app/node_modules/viem/_esm/accounts/index.js';
import { foundry } from '../../app/node_modules/viem/_esm/chains/index.js';
import { ProgramService } from '../lib/program-service.mjs';
import { ProgramStore } from '../lib/program-service-store.mjs';
import { CAMPAIGN_ABI, CASHBACK_ABI } from '../lib/program-service-abi.mjs';
import { feeVoucherData } from '../lib/cashback.mjs';

// Opt in: PLUGGED_PROGRAMS_INTEGRATION=1 bun test ./plugged/test/program-service.integration.test.mjs
// Starts its own ephemeral localhost chain. No external RPC, fork, download, or persisted state.
const integration=process.env.PLUGGED_PROGRAMS_INTEGRATION==='1'?describe:describe.skip;
const mnemonic='test test test test test test test test test test test junk';
const accounts=Array.from({length:4},(_,addressIndex)=>mnemonicToAccount(mnemonic,{addressIndex}));
const [deployer,alice,beneficiary,outsider]=accounts;
const attestor=privateKeyToAccount(`0x${'55'.repeat(32)}`);
const evidence=keccak256(toHex('local verified trade fixture'));
const artifact=(source,name=source)=>JSON.parse(readFileSync(new URL(`../contracts/out/${source}.sol/${name}.json`,import.meta.url),'utf8'));

integration('program service against real ephemeral Anvil deployments',()=>{
  let processHandle,client,wallets,clock,campaignArtifact,cashbackArtifact,tokenArtifact;
  const services=[];

  beforeAll(async()=>{
    const binary=process.env.PLUGGED_ANVIL_BIN||join(homedir(),'.foundry','bin',process.platform==='win32'?'anvil.exe':'anvil');
    if(!existsSync(binary))throw new Error('Existing Anvil required; set PLUGGED_ANVIL_BIN. This suite never downloads tools.');
    campaignArtifact=artifact('PluggedCampaign');cashbackArtifact=artifact('PluggedCashback');
    tokenArtifact=artifact('PluggedFeeSplitter.t','QuoteToken');
    // Reserve an OS-selected port briefly, then give it exclusively to this Anvil process.
    const server=createServer();
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    processHandle=Bun.spawn([binary,'--host','127.0.0.1','--port',String(port),'--chain-id','31337','--hardfork','cancun','--mnemonic',mnemonic,'--silent'],{stdout:'ignore',stderr:'pipe'});
    const transport=http(`http://127.0.0.1:${port}`,{retryCount:0,timeout:1000});
    client=createPublicClient({chain:foundry,transport,cacheTime:0,pollingInterval:10});
    wallets=accounts.map(account=>createWalletClient({chain:foundry,transport,account,cacheTime:0}));
    let ready=false;
    for(let attempt=0;attempt<80;attempt++) {
      if(processHandle.exitCode!==null)throw new Error(`Anvil exited: ${await new Response(processHandle.stderr).text()}`);
      try {if(await client.getChainId()===31337){ready=true;break;}} catch {}
      await Bun.sleep(50);
    }
    if(!ready)throw new Error('Private Anvil failed to start within four seconds.');
    clock=Number((await client.getBlock()).timestamp)*1000;
  },15000);

  afterEach(()=>{for(const service of services.splice(0))service.close();});
  afterAll(async()=>{if(processHandle){processHandle.kill();await processHandle.exited;}},10000);

  const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args});
  async function mined(hash) {
    const receipt=await client.waitForTransactionReceipt({hash});
    expect(receipt.status).toBe('success');return receipt;
  }
  async function deploy(a,args=[]) {
    const receipt=await mined(await wallets[0].deployContract({abi:a.abi,bytecode:a.bytecode.object,args}));
    return {address:receipt.contractAddress,receipt};
  }
  async function write(index,address,abi,functionName,args=[],value=0n) {
    return mined(await wallets[index].writeContract({address,abi,functionName,args,value}));
  }
  async function advance(timestamp) {
    await client.request({method:'evm_setNextBlockTimestamp',params:[Number(timestamp)]});
    await client.request({method:'evm_mine',params:[]});clock=Number(timestamp)*1000;
  }
  function serviceFor(manifest,options={}) {
    const service=new ProgramService({client,manifest:[manifest],enabled:true,store:new ProgramStore(':memory:'),now:()=>clock,...options});
    services.push(service);return service;
  }
  async function program(kind,{currency=zeroAddress,decimals=18,goal=parseEther('2'),budget=parseEther('2')}={}) {
    const deadline=(await client.getBlock()).timestamp+3600n;
    const args=kind==='campaign'?[currency,beneficiary.address,goal,deadline]:[currency,attestor.address,1000n,budget];
    const deployment=await deploy(kind==='campaign'?campaignArtifact:cashbackArtifact,args);
    const manifest={id:`${kind}-${deployment.receipt.blockNumber}`,kind,name:'Local integration fixture',chainId:31337,localTest:true,address:deployment.address,
      codeHash:keccak256(await client.getCode({address:deployment.address})),deploymentBlock:deployment.receipt.blockNumber.toString(),deploymentBlockHash:deployment.receipt.blockHash,
      currency,decimals,symbol:currency===zeroAddress?'ETH':'QUOTE',
      ...(kind==='campaign'?{beneficiary:beneficiary.address,goal:goal.toString(),deadline:deadline.toString()}:{attestor:attestor.address,rebateBps:'1000',budget:budget.toString()})};
    if(currency!==zeroAddress)manifest.currencyCodeHash=keccak256(await client.getCode({address:currency}));
    return {manifest,address:deployment.address,deadline,service:serviceFor(manifest)};
  }
  async function sendPrepared(service,record,index=1) {
    const t=record.transaction;
    const hash=await wallets[index].sendTransaction({to:t.to,data:t.data,value:BigInt(t.value),gas:BigInt(t.gas)});
    const receipt=await mined(hash);
    expect((await service.submit(record.id,hash)).status).toBe('submitted');
    await client.request({method:'anvil_mine',params:['0x2']});
    const confirmed=await service.status(record.id);
    expect(confirmed.status).toBe('confirmed');expect(confirmed.txHash).toBe(hash);
    return receipt;
  }
  const prepare=(p,action,fields={},index=1)=>p.service.prepare({programId:p.manifest.id,account:accounts[index].address,action,...fields});
  async function sign(p,{cumulativeFees=parseEther('2').toString(),validUntil=(BigInt(clock/1000)+7200n).toString(),trader=alice.address}={},domain={},signer=attestor) {
    const v={trader,cumulativeFees,validUntil,evidence};
    return {...v,signature:await signer.signTypedData(feeVoucherData({...p.manifest,...domain},v))};
  }
  const claimArgs=v=>[v.trader,BigInt(v.cumulativeFees),BigInt(v.validUntil),v.evidence,v.signature];

  test('native success pays only the fixed beneficiary after deadline, exactly once',async()=>{
    const p=await program('campaign');
    const before=await client.getBalance({address:beneficiary.address});
    await sendPrepared(p.service,await prepare(p,'contribute',{amount:'2.5'}));
    expect((await p.service.details(p.manifest.id,{account:alice.address}))).toMatchObject({phase:'open',contribution:parseEther('2.5').toString()});
    await expect(prepare(p,'payout',{},3)).rejects.toThrow('after the deadline');
    await expect(client.simulateContract({address:p.address,abi:campaignArtifact.abi,functionName:'payout',account:outsider.address})).rejects.toThrow();
    await advance(p.deadline);
    expect((await p.service.details(p.manifest.id)).phase).toBe('successful');
    await expect(prepare(p,'contribute',{amount:'1'})).rejects.toThrow('deadline');
    const payout=await prepare(p,'payout',{},3);
    expect(decodeFunctionData({abi:CAMPAIGN_ABI,data:payout.transaction.data}).functionName).toBe('payout');
    await sendPrepared(p.service,payout,3);
    expect(await client.getBalance({address:beneficiary.address})-before).toBe(parseEther('2.5'));
    expect(await client.getBalance({address:p.address})).toBe(0n);
    expect((await p.service.details(p.manifest.id)).phase).toBe('paid');
    await expect(prepare(p,'payout',{},3)).rejects.toThrow('only once');
    await expect(prepare(p,'refund')).rejects.toThrow('No failed-goal refund');
  },30000);

  test('failed-goal refunds return to original contributors, including permissionless relays',async()=>{
    const p=await program('campaign');
    await sendPrepared(p.service,await prepare(p,'contribute',{amount:'0.6'}));
    await sendPrepared(p.service,await prepare(p,'contribute',{amount:'0.4'},0),0);
    await expect(prepare(p,'refund')).rejects.toThrow('No failed-goal refund');
    await advance(p.deadline);
    expect(await p.service.details(p.manifest.id,{account:alice.address})).toMatchObject({phase:'failed',refundable:parseEther('0.6').toString()});
    await expect(prepare(p,'payout',{},3)).rejects.toThrow();
    await expect(prepare(p,'refund',{},3)).rejects.toThrow('No failed-goal refund');
    const before=await client.getBalance({address:alice.address});
    const receipt=await sendPrepared(p.service,await prepare(p,'refund'));
    const after=await client.getBalance({address:alice.address});
    expect(after-before+receipt.gasUsed*receipt.effectiveGasPrice).toBe(parseEther('0.6'));
    const original=await client.getBalance({address:deployer.address});
    await write(3,p.address,campaignArtifact.abi,'refund',[deployer.address]);
    expect(await client.getBalance({address:deployer.address})-original).toBe(parseEther('0.4'));
    expect(await read(p.address,CAMPAIGN_ABI,'totalRefunded')).toBe(parseEther('1'));
    expect(await read(p.address,CAMPAIGN_ABI,'contributions',[alice.address])).toBe(0n);
    expect(await client.getBalance({address:p.address})).toBe(0n);
    await expect(prepare(p,'refund')).rejects.toThrow('No failed-goal refund');
    await expect(client.simulateContract({address:p.address,abi:campaignArtifact.abi,functionName:'refund',args:[deployer.address],account:outsider.address})).rejects.toThrow();
  },30000);

  test('ERC20 contribution executes reset → exact approval → payment; taxed currency is rejected',async()=>{
    const token=await deploy(tokenArtifact);
    const p=await program('campaign',{currency:token.address,decimals:6,goal:10000000n});
    await write(0,token.address,tokenArtifact.abi,'mint',[alice.address,100000000n]);
    await write(1,token.address,erc20Abi,'approve',[p.address,1000000n]);
    const reset=await prepare(p,'contribute',{amount:'10'});
    expect(reset.next).toBe('reset-approval');
    expect(decodeFunctionData({abi:erc20Abi,data:reset.transaction.data})).toEqual({functionName:'approve',args:[getAddress(p.address),0n]});
    await sendPrepared(p.service,reset);
    expect(await read(token.address,erc20Abi,'allowance',[alice.address,p.address])).toBe(0n);
    const approval=await prepare(p,'contribute',{amount:'10'});
    expect(approval.next).toBe('approve');await sendPrepared(p.service,approval);
    expect(await read(token.address,erc20Abi,'allowance',[alice.address,p.address])).toBe(10000000n);
    const payment=await prepare(p,'contribute',{amount:'10'});
    expect(payment.next).toBe('send');expect(payment.transaction.value).toBe('0x0');
    await sendPrepared(p.service,payment);
    expect(await read(token.address,erc20Abi,'balanceOf',[p.address])).toBe(10000000n);
    expect(await read(p.address,CAMPAIGN_ABI,'contributions',[alice.address])).toBe(10000000n);
    await expect(prepare(p,'contribute',{amount:'0.0000001'})).rejects.toThrow('precision');
    await expect(prepare(p,'contribute',{amount:'1000'})).rejects.toThrow('Insufficient');
    await write(1,token.address,erc20Abi,'approve',[p.address,1000000n]);
    await write(0,token.address,tokenArtifact.abi,'setTax',[true]);
    await expect(prepare(p,'contribute',{amount:'1'})).rejects.toThrow();
    expect(await read(p.address,CAMPAIGN_ABI,'totalContributed')).toBe(10000000n);
    await write(0,token.address,tokenArtifact.abi,'setTax',[false]);
    await advance(p.deadline);
    await sendPrepared(p.service,await prepare(p,'payout',{},3),3);
    expect(await read(token.address,erc20Abi,'balanceOf',[beneficiary.address])).toBe(10000000n);
  },30000);

  test('signed cumulative cashback verifies on-chain domain, deltas, replay and independent budget',async()=>{
    const p=await program('cashback');
    await expect(p.service.voucher({programId:p.manifest.id,account:alice.address})).rejects.toThrow('attestor is not configured');
    await sendPrepared(p.service,await prepare(p,'fund',{amount:'1'},0),0);
    const first=await sign(p);
    expect(await read(p.address,CASHBACK_ABI,'voucherDigest',claimArgs(first).slice(0,4))).toBe(hashTypedData(feeVoucherData(p.manifest,first)));
    const before=await client.getBalance({address:alice.address});
    const firstReceipt=await sendPrepared(p.service,await prepare(p,'claim',{voucher:first}));
    expect(await client.getBalance({address:alice.address})-before+firstReceipt.gasUsed*firstReceipt.effectiveGasPrice).toBe(parseEther('0.2'));
    await expect(prepare(p,'claim',{voucher:first})).rejects.toThrow('nothing left to claim');
    await expect(client.simulateContract({address:p.address,abi:cashbackArtifact.abi,functionName:'claim',args:claimArgs(first),account:outsider.address})).rejects.toThrow();
    const second=await sign(p,{cumulativeFees:parseEther('3').toString()});
    const secondRecord=await prepare(p,'claim',{voucher:second});
    expect(secondRecord.accounting.due).toBe(parseEther('0.1').toString());
    await sendPrepared(p.service,secondRecord);
    const third=await sign(p,{cumulativeFees:parseEther('4').toString()});
    const original=await client.getBalance({address:alice.address});
    await write(3,p.address,cashbackArtifact.abi,'claim',claimArgs(third));
    expect(await client.getBalance({address:alice.address})-original).toBe(parseEther('0.1'));
    expect(await p.service.details(p.manifest.id,{account:alice.address})).toMatchObject({claimed:parseEther('0.4').toString(),totalClaimed:parseEther('0.4').toString(),available:parseEther('0.6').toString(),fundingRemaining:parseEther('1').toString()});
    const excessive=await sign(p,{cumulativeFees:parseEther('20').toString()});
    await expect(prepare(p,'claim',{voucher:excessive})).rejects.toThrow('partial claims are not supported');
    await expect(client.simulateContract({address:p.address,abi:cashbackArtifact.abi,functionName:'claim',args:claimArgs(excessive),account:alice.address})).rejects.toThrow();
    await expect(prepare(p,'fund',{amount:'1.000000000000000001'},0)).rejects.toThrow('independent cashback budget');
    await expect(client.simulateContract({address:p.address,abi:cashbackArtifact.abi,functionName:'fund',args:[parseEther('2')],value:parseEther('2'),account:deployer.address})).rejects.toThrow();
    expect(await read(p.address,CASHBACK_ABI,'totalClaimed')).toBe(parseEther('0.4'));
  },30000);

  test('expired, wrong-signer, cross-chain, cross-contract and wallet-retargeted vouchers fail',async()=>{
    const p=await program('cashback');
    await sendPrepared(p.service,await prepare(p,'fund',{amount:'1'},0),0);
    const other=await program('cashback');
    const now=(await client.getBlock()).timestamp;
    const invalid=[
      [await sign(p,{validUntil:(now-1n).toString()}),'expired'],
      [await sign(p,{}, {},outsider),'immutable attestor'],
      [await sign(p,{}, {chainId:4663}),'immutable attestor'],
      [await sign(p,{}, {address:other.address}),'immutable attestor'],
    ];
    for(const [voucher,message] of invalid) {
      await expect(prepare(p,'claim',{voucher})).rejects.toThrow(message);
      await expect(client.simulateContract({address:p.address,abi:cashbackArtifact.abi,functionName:'claim',args:claimArgs(voucher),account:alice.address})).rejects.toThrow();
    }
    const valid=await sign(p);
    await expect(prepare(p,'claim',{voucher:valid},3)).rejects.toThrow('different wallet');
    const tampered={...valid,trader:outsider.address};
    await expect(prepare(p,'claim',{voucher:tampered},3)).rejects.toThrow('immutable attestor');
    await expect(client.simulateContract({address:p.address,abi:cashbackArtifact.abi,functionName:'claim',args:claimArgs(tampered),account:outsider.address})).rejects.toThrow();
    expect(await read(p.address,CASHBACK_ABI,'totalClaimed')).toBe(0n);
    expect(await client.getBalance({address:p.address})).toBe(parseEther('1'));
  },30000);

  test('real receipts reject provider mismatches and undeployed manifests stay gated',async()=>{
    const p=await program('campaign');
    const record=await prepare(p,'contribute',{amount:'1'}),t=record.transaction;
    const hash=await wallets[1].sendTransaction({to:t.to,data:t.data,value:BigInt(t.value),gas:BigInt(t.gas)});
    const receipt=await mined(hash);
    await client.request({method:'anvil_mine',params:['0x2']});
    for(const altered of [
      {...receipt,from:outsider.address},
      {...receipt,to:outsider.address},
      {...receipt,logs:receipt.logs.map(log=>({...log,address:outsider.address}))},
      {...receipt,logs:[...receipt.logs,...receipt.logs]},
    ]) {
      p.service.client={...client,getTransactionReceipt:async()=>altered};
      await expect(p.service.submit(record.id,hash)).rejects.toThrow(/Receipt (does not match|event does not match)/);
      expect(p.service.store.get(record.id).status).not.toBe('confirmed');
    }
    p.service.client=client;
    expect((await p.service.status(record.id)).status).toBe('confirmed');
    const undeployed=serviceFor({...p.manifest,id:'missing',address:outsider.address});
    expect((await undeployed.list()).status).toBe('undeployed');
    await expect(undeployed.prepare({programId:'missing',account:alice.address,action:'contribute',amount:'1'})).rejects.toThrow('bytecode is absent');
  },30000);
});
