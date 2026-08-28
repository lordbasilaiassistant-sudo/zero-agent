#!/usr/bin/env node
/* EOA-quota harvest: Rhinestone sends FROM the EOA (sponsored). Never spends EOA ETH.
   Inner harvest(address=EOA) so WETH lands at the spendable account. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { LIVE_EOA, RETIRED_EOA } from '../shop.mjs';
import { harvestCalldata, RELAY_HEADERS, relayRequestBody, relayUrl, relayBudget } from '../harvest.mjs';

if (!process.argv.includes('--spend')) {
  console.error('REFUSED: spends EOA relay quota. Pass --spend.');
  process.exit(2);
}

const RPC = 'https://base-rpc.publicnode.com';
const WETH = '0x4200000000000000000000000000000000000006';
const STRATS = [
  '0xafF4f20E5F340f11944DB3eC9adE6A29c13FE67d',
  '0xAC3C1D42E3f26FC2c6fE3737b2665373304E1891',
  '0x9C23e7C0c8b8f1B94959214da77c35f2a97De602',
  '0xf80E2fe60CCf4d6586A72444F4576e4e1F2978cd',
  '0x938d1e3CF9383BFD3A9a4Fbb22E8CB1A70b0bb7e',
  '0x295EE9dC968b939B4276911217D6C9883D6f588f',
];

const envf = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const PK = envf.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim();
const wallet = new ethers.Wallet(PK);
if (wallet.address.toLowerCase() !== LIVE_EOA.toLowerCase()) throw new Error(`key ${wallet.address}`);
if (wallet.address.toLowerCase() === RETIRED_EOA.toLowerCase()) throw new Error('retired key');

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const balOf = async (who) => BigInt(await rpc('eth_call', [{ to: WETH, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));

const dataHarvest = harvestCalldata(LIVE_EOA, true);
const good = [];
for (const s of STRATS) {
  try {
    await rpc('eth_call', [{ to: s, data: dataHarvest, from: LIVE_EOA }, 'latest']);
    good.push(s);
    console.log('sim ok', s);
  } catch (e) {
    console.log('sim fail', s, String(e.message).slice(0, 120));
  }
}
if (!good.length) {
  console.log('nothing simulates clean from EOA');
  process.exit(1);
}

const budget = await relayBudget(LIVE_EOA, 8453);
console.log('eoa quota', budget);
if (!budget.remaining) {
  console.log('NO QUOTA');
  process.exit(1);
}

// EOA Rhinestone 422s MultiSend ("batch is not all execTransaction calls to same address").
// One harvest per slot. Quota is not consumed on 422.
const to = good[0];
const data = dataHarvest;

const ethBefore = BigInt(await rpc('eth_getBalance', [LIVE_EOA, 'latest']));
const wethBefore = await balOf(LIVE_EOA);
console.log('before', { eth: ethBefore.toString(), weth: wethBefore.toString(), n: good.length, to });

const res = await fetch(relayUrl(8453), {
  method: 'POST',
  headers: RELAY_HEADERS,
  body: JSON.stringify(relayRequestBody({ to, data, gasLimit: '1000000' })),
});
const text = await res.text();
console.log('relay HTTP', res.status, text.slice(0, 240));
if (res.status !== 201) process.exit(1);
const taskId = JSON.parse(text).taskId;
console.log('taskId', taskId);

for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const st = await (await fetch(`${relayUrl(8453)}/status/${taskId}`, { headers: RELAY_HEADERS })).json();
  const t = st.task || st;
  console.log(i, t.status ?? t.taskState, t.transactionHash || t.receipt?.transactionHash || '', t.lastCheckMessage || '');
  const tx = t.transactionHash || t.receipt?.transactionHash;
  if (tx || /400|reject|revert|cancel|fail/i.test(String(t.status ?? t.taskState ?? t.lastCheckMessage ?? ''))) break;
}

const ethAfter = BigInt(await rpc('eth_getBalance', [LIVE_EOA, 'latest']));
const wethAfter = await balOf(LIVE_EOA);
const quotaAfter = await relayBudget(LIVE_EOA, 8453);
console.log('after', {
  eth: ethAfter.toString(),
  weth: wethAfter.toString(),
  dEth: (ethAfter - ethBefore).toString(),
  dWeth: (wethAfter - wethBefore).toString(),
  quota: quotaAfter,
});
