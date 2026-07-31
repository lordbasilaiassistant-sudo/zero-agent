// measure-callreward.mjs — the number that decides whether ZeroHarvester is worth deploying.
//
// THE QUESTION: batching turns one relay slot into up to 256 harvest attempts. That is only worth
// anything if, at a given moment, SOME strategies have a pending caller fee. If nothing anywhere is
// ever pending, batching multiplies zero. So: sweep live Base strategies, read what each would pay a
// caller RIGHT NOW, and report the real distribution.
//
// Read-only. Multicall3 aggregate3 (CLAUDE.md 8: never per-token loops, never the explorer API).
import { ethers } from 'ethers';
import fs from 'node:fs';

const RPC = process.env.BASE_RPC || 'https://base-rpc.publicnode.com';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const LIMIT = Number(process.env.LIMIT || 120);

const mc = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
]);
const vaultI = new ethers.Interface(['function strategy() view returns (address)']);
const stratI = new ethers.Interface([
  'function callReward() view returns (uint256)',
  'function harvest(address) external',
  'function lastHarvest() view returns (uint256)',
  'function paused() view returns (bool)',
]);

const p = new ethers.JsonRpcProvider(RPC);

async function agg(calls) {
  const data = mc.encodeFunctionData('aggregate3', [calls]);
  const raw = await p.call({ to: MULTICALL3, data });
  return mc.decodeFunctionResult('aggregate3', raw)[0];
}

// chunk to keep each aggregate3 under any node's response limit
async function aggAll(calls, size = 100) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    out.push(...(await agg(calls.slice(i, i + size))));
  }
  return out;
}

const vaults = JSON.parse(fs.readFileSync(new URL('../_beefy_base.json', import.meta.url), 'utf8'))
  .filter((v) => v.status === 'active' && v.earnContractAddress)
  .slice(0, LIMIT);

console.log(`sweeping ${vaults.length} active Base vaults via Multicall3 …\n`);

// 1. vault -> strategy
const stratRes = await aggAll(
  vaults.map((v) => ({ target: v.earnContractAddress, allowFailure: true, callData: vaultI.encodeFunctionData('strategy') })),
);
const strategies = [];
stratRes.forEach((r, i) => {
  if (!r.success || r.returnData === '0x') return;
  try {
    const [addr] = vaultI.decodeFunctionResult('strategy', r.returnData);
    if (addr && addr !== ethers.ZeroAddress) strategies.push({ vault: vaults[i].id, strategy: addr });
  } catch {}
});
console.log(`resolved ${strategies.length} strategy contracts`);

// 2. callReward() + paused() on each strategy
const rewardRes = await aggAll(
  strategies.map((s) => ({ target: s.strategy, allowFailure: true, callData: stratI.encodeFunctionData('callReward') })),
);
const pausedRes = await aggAll(
  strategies.map((s) => ({ target: s.strategy, allowFailure: true, callData: stratI.encodeFunctionData('paused') })),
);

let exposes = 0;
const paying = [];
rewardRes.forEach((r, i) => {
  if (!r.success || r.returnData === '0x') return;
  exposes++;
  let wei = 0n;
  try {
    [wei] = stratI.decodeFunctionResult('callReward', r.returnData);
  } catch {
    return;
  }
  let isPaused = false;
  try {
    if (pausedRes[i]?.success && pausedRes[i].returnData !== '0x') {
      [isPaused] = stratI.decodeFunctionResult('paused', pausedRes[i].returnData);
    }
  } catch {}
  if (wei > 0n) paying.push({ ...strategies[i], wei, paused: isPaused });
});

// 3. price it
let ethUsd = 0;
try {
  const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  ethUsd = parseFloat((await r.json()).data.amount);
} catch {}

paying.sort((a, b) => (b.wei > a.wei ? 1 : -1));
const total = paying.reduce((s, x) => s + x.wei, 0n);
const usd = (w) => (Number(ethers.formatEther(w)) * ethUsd).toFixed(6);

console.log(`\n=== MEASURED, block ${await p.getBlockNumber()}, ETH $${ethUsd} ===`);
console.log(`strategies exposing callReward(): ${exposes}/${strategies.length}`);
console.log(`WITH A PENDING CALLER FEE RIGHT NOW: ${paying.length}`);
console.log(`total claimable this instant     : ${ethers.formatEther(total)} ETH = $${usd(total)}`);
console.log(`\ntop 12 payers:`);
for (const x of paying.slice(0, 12)) {
  console.log(`  $${usd(x.wei).padStart(10)}  ${x.strategy}  ${x.paused ? '[PAUSED]' : ''} ${x.vault}`);
}

const unpaused = paying.filter((x) => !x.paused);
const unpausedTotal = unpaused.reduce((s, x) => s + x.wei, 0n);
console.log(`\nunpaused only: ${unpaused.length} strategies, $${usd(unpausedTotal)} claimable`);

// 4. what the batch is worth vs what one call is worth — the entire thesis, as a number
const gasPrice = (await p.getFeeData()).gasPrice ?? 0n;
const perCallGas = 250_000n; // conservative for a real harvest
const batchGas = BigInt(Math.min(unpaused.length, 256)) * perCallGas + 100_000n;
const batchCostWei = batchGas * gasPrice;
console.log(`\n=== THE THESIS, PRICED ===`);
console.log(`gas price            : ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
console.log(`one harvest costs    : $${usd(perCallGas * gasPrice)}`);
console.log(`batch of ${Math.min(unpaused.length, 256)} costs   : $${usd(batchCostWei)}`);
console.log(`batch would collect  : $${usd(unpausedTotal)}`);
console.log(`NET IF BATCHED NOW   : $${(Number(ethers.formatEther(unpausedTotal - batchCostWei)) * ethUsd).toFixed(6)}`);
console.log(`\n(one-at-a-time, ZERO could only reach ${5} of these per day per chain — the relay cap.)`);

fs.writeFileSync(
  new URL('./callreward-measurement.json', import.meta.url),
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      block: await p.getBlockNumber(),
      ethUsd,
      vaultsScanned: vaults.length,
      strategiesResolved: strategies.length,
      exposingCallReward: exposes,
      withPendingFee: paying.length,
      totalClaimableEth: ethers.formatEther(total),
      totalClaimableUsd: Number(usd(total)),
      unpausedCount: unpaused.length,
      unpausedClaimableUsd: Number(usd(unpausedTotal)),
      gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
      top: paying.slice(0, 25).map((x) => ({ strategy: x.strategy, vault: x.vault, usd: Number(usd(x.wei)), paused: x.paused })),
    },
    null,
    2,
  ) + '\n',
);
console.log('\n→ contracts/callreward-measurement.json');
