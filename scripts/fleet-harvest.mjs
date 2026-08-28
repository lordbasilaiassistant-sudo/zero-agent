#!/usr/bin/env node
/* Harvest from extra GENESIS II Safes that already have unused Base relay buckets.
   feeTo = EOA. Never funds. Never spends EOA ETH. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { LIVE_EOA, RETIRED_EOA, SMART_ACCOUNT } from '../shop.mjs';
import { harvestCalldata, MULTISEND, RELAY_HEADERS, relayBudget, relayExec, relayUrl } from '../harvest.mjs';
import { probeMany } from '../oracle.mjs';

if (!process.argv.includes('--spend')) {
  console.error('REFUSED: spends fleet Safe relay quota. Pass --spend.');
  process.exit(2);
}

const FLEET = [
  '0x3e4C5b87069a141a1f84397855349C99C87A63cC',
  '0x1744b8FDD9548C4B98616B14901011133B87aB73',
];
const RPC = 'https://base-rpc.publicnode.com';
const RPC_FAILOVER = ['https://base.drpc.org', 'https://1rpc.io/base'];
const WETH = '0x4200000000000000000000000000000000000006';
const OWNERS_SEL = '0xa0e67e2b';

const envf = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const PK = envf.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim();
const wallet = new ethers.Wallet(PK);
if (wallet.address.toLowerCase() !== LIVE_EOA.toLowerCase()) throw new Error(`key ${wallet.address}`);
if (wallet.address.toLowerCase() === RETIRED_EOA.toLowerCase()) throw new Error('retired key');
const env = { AGENT_PRIVATE_KEY: PK };

async function rpcRaw(method, params) {
  let last;
  for (const url of [RPC, ...RPC_FAILOVER]) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const rpc = (chain, method, params) => rpcRaw(method, params);

const packCall = (to, data) =>
  '00' + to.slice(2).toLowerCase() + '0'.repeat(64) +
  (data.length / 2 - 1).toString(16).padStart(64, '0') + data.slice(2);

const balOf = async (who) => BigInt(await rpcRaw('eth_call', [{ to: WETH, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));

async function verify(safe) {
  const [code, ownersRaw, nonceRaw, budget] = await Promise.all([
    rpcRaw('eth_getCode', [safe, 'latest']),
    rpcRaw('eth_call', [{ to: safe, data: OWNERS_SEL }, 'latest']),
    rpcRaw('eth_call', [{ to: safe, data: '0xaffed0e0' }, 'latest']),
    relayBudget(safe, 8453),
  ]);
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address[]'], ownersRaw);
  const owners = decoded[0].map(a => a.toLowerCase());
  return {
    safe,
    bytes: (code.length - 2) / 2,
    owners,
    ownerOk: owners.includes(LIVE_EOA.toLowerCase()),
    nonce: BigInt(nonceRaw || '0x0').toString(),
    remaining: budget.remaining,
    limit: budget.limit,
    budgetError: budget.error || null,
  };
}

async function poll(taskId) {
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await (await fetch(`${relayUrl(8453)}/status/${taskId}`, { headers: RELAY_HEADERS })).json();
    const t = st.task || st;
    const tx = t.transactionHash || t.receipt?.transactionHash || null;
    console.log('poll', i, t.status ?? t.taskState, tx || '', t.lastCheckMessage || '');
    if (tx) return { tx, status: t.status ?? t.taskState };
    if (/400|reject|revert|cancel|fail/i.test(String(t.status ?? t.taskState ?? t.lastCheckMessage ?? ''))) {
      return { tx: null, status: t.status ?? t.taskState, msg: t.lastCheckMessage };
    }
  }
  return { tx: null, status: 'timeout' };
}

const harvestData = harvestCalldata(LIVE_EOA, true);
const census = [];
for (const s of FLEET) census.push(await verify(s));
console.log('census', JSON.stringify(census, null, 2));
const usable = census.filter(c => c.bytes > 4 && c.ownerOk && c.remaining >= 1);
if (!usable.length) {
  console.log('NO USABLE FLEET SAFE');
  process.exit(1);
}

let queue = [];
try {
  queue = JSON.parse(fs.readFileSync(path.join('C:\\Users\\drlor\\OneDrive\\Desktop\\AutoGLMwallet', 'state', 'verified-harvest-queue.json'), 'utf8')).queue || [];
} catch { /* empty */ }
const candidates = [...new Set([
  ...queue.map(r => ethers.getAddress(r.contract)),
  '0xafF4f20E5F340f11944DB3eC9adE6A29c13FE67d',
  '0xAC3C1D42E3f26FC2c6fE3737b2665373304E1891',
  '0x9C23e7C0c8b8f1B94959214da77c35f2a97De602',
  '0x938d1e3CF9383BFD3A9a4Fbb22E8CB1A70b0bb7e',
  '0x295EE9dC968b939B4276911217D6C9883D6f588f',
  '0x6aEa497106845bCE2CCe35E770a12a63288c5B65',
])];

const paying = await probeMany(rpc, 'base', candidates, WETH, 'harvest(address)', 20);
console.log('paying', paying.length, paying.slice(0, 12));

const good = [];
for (const p of paying) {
  if (good.length >= usable.length * 6) break;
  try {
    await rpcRaw('eth_call', [{ to: p.contract, data: harvestData, from: usable[0].safe }, 'latest']);
    good.push(p);
  } catch { /* skip */ }
}
if (!good.length) {
  console.log('nothing simulates clean');
  process.exit(1);
}

const ethBefore = BigInt(await rpcRaw('eth_getBalance', [LIVE_EOA, 'latest']));
const wethBefore = await balOf(LIVE_EOA);
const results = [];

for (let i = 0; i < usable.length; i++) {
  const slice = good.slice(i * 6, i * 6 + 6);
  if (!slice.length) break;
  const u = usable[i];
  let batch = '0x';
  for (const g of slice) batch += packCall(g.contract, harvestData);
  const msData = new ethers.Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [batch]);
  try {
    await rpcRaw('eth_call', [{ to: MULTISEND, data: msData, from: u.safe }, 'latest']);
  } catch (e) {
    console.log('batch reverts', u.safe, String(e.message).slice(0, 160));
    continue;
  }
  const predicted = slice.reduce((a, g) => a + BigInt(g.wei), 0n);
  console.log('relaying', u.safe, 'n', slice.length, 'predicted_wei', predicted.toString());
  const sent = await relayExec(env, rpc, u.safe, MULTISEND, msData, 'base', 8453, 1);
  console.log('sent', sent);
  const row = { safe: u.safe, n: slice.length, predicted_wei: predicted.toString(), ...sent };
  if (sent.ok && sent.taskId) {
    const polled = await poll(sent.taskId);
    Object.assign(row, polled);
  }
  results.push(row);
}

const ethAfter = BigInt(await rpcRaw('eth_getBalance', [LIVE_EOA, 'latest']));
const wethAfter = await balOf(LIVE_EOA);
const out = {
  at: new Date().toISOString(),
  genesisII: SMART_ACCOUNT,
  census,
  eoa_eth_before: ethBefore.toString(),
  eoa_weth_before: wethBefore.toString(),
  eoa_eth_after: ethAfter.toString(),
  eoa_weth_after: wethAfter.toString(),
  dEth: (ethAfter - ethBefore).toString(),
  dWeth: (wethAfter - wethBefore).toString(),
  results,
};
fs.writeFileSync(path.join('C:\\Users\\drlor\\OneDrive\\Desktop\\AutoGLMwallet', 'scripts', 'fleet-harvest-result.json'), JSON.stringify(out, null, 2));
console.log('DONE', JSON.stringify({ dEth: out.dEth, dWeth: out.dWeth, results: results.map(r => ({ safe: r.safe, ok: r.ok, status: r.status, tx: r.tx })) }, null, 2));
