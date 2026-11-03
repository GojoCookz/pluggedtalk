import { expect, test } from 'bun:test';
import { LaunchStore } from '../lib/launch-store.mjs';
import { RewardsStore } from '../lib/rewards-store.mjs';
import { ProgramStore } from '../lib/program-service-store.mjs';
import { LaunchService } from '../lib/launch-service.mjs';
import { routeInput } from '../lib/market-services.mjs';
import { boundedJson } from '../lib/fetch-json.mjs';

const DAY = 86400000;

test('L1/M4: reward tx hash is unique and stale unsigned preparations are pruned', () => {
  const launches = new LaunchStore(':memory:'), rewards = new RewardsStore(launches.db);
  rewards.save({ id: 'a', createdAt: 0 });
  rewards.save({ id: 'b', createdAt: 0, txHash: '0xab' });
  rewards.save({ id: 'c', createdAt: DAY * 2 });
  expect(() => rewards.save({ id: 'd', createdAt: DAY * 2, txHash: '0xAB' })).toThrow();
  rewards.prune(DAY * 2);
  expect(rewards.get('a')).toBeNull();
  expect(rewards.get('b')).not.toBeNull(); // signed records are kept
  expect(rewards.get('c')).not.toBeNull();
  const programs = new ProgramStore(launches.db);
  programs.save({ id: 'p1', status: 'prepared', createdAt: 0 });
  programs.save({ id: 'p2', status: 'submitted', txHash: '0x1', createdAt: 0 });
  programs.prune(DAY * 2);
  expect(programs.get('p1')).toBeNull(); expect(programs.get('p2')).not.toBeNull();
  launches.close();
});

test('L3: reconciliation picks least-recently-checked submissions first', () => {
  const store = new LaunchStore(':memory:');
  for (let i = 0; i < 3; i++) store.save({ id: `r${i}`, fingerprint: `f${i}`, status: 'submitted', createdAt: i, txHash: `0x${i}` });
  expect(store.listForReconcile('submitted', 1)[0].id).toBe('r0');
  store.checked('r0', 10); store.checked('r1', 11);
  expect(store.listForReconcile('submitted', 1)[0].id).toBe('r2');
  store.close();
});

test('L3: submissions without a receipt after a day become dropped', async () => {
  const store = new LaunchStore(':memory:');
  const client = { getTransactionReceipt: async () => { throw Object.assign(new Error('missing'), { name: 'TransactionReceiptNotFoundError' }); } };
  const service = new LaunchService({ store, client, now: () => DAY + 1000 });
  service.view = r => r;
  const record = store.save({ id: 'x', fingerprint: 'f', status: 'submitted', createdAt: 0, txHash: '0x1' });
  await service.confirm(record);
  expect(store.get('x').status).toBe('dropped');
  store.close();
});

test('M1: deployment verification runs once per block', async () => {
  let calls = 0;
  const service = new LaunchService({ store: {}, client: {} });
  service.verifyDeployment = async () => { calls++; return { ok: true }; };
  await Promise.all([service.deployment(5n), service.deployment(5n), service.deployment(5n)]);
  expect(calls).toBe(1);
  await service.deployment(6n);
  expect(calls).toBe(2);
});

test('M2/L8: route amount bound and capped provider bodies', async () => {
  const quote = (await import('../lib/config.mjs')).QUOTES.find(q => !q.native).address;
  const account = '0x' + '1'.repeat(40);
  expect(() => routeInput({ quote, account, amountEth: '10.5' })).toThrow('limited');
  expect(routeInput({ quote, account, amountEth: '1' }).amount).toBe(10n ** 18n);
  await expect(boundedJson(new Response('x'.repeat(2000)), 1000)).rejects.toThrow('too large');
  expect(await boundedJson(new Response('{"a":1}'), 1000)).toEqual({ a: 1 });
});
