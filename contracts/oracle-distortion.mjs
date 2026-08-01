// oracle-distortion.mjs — does the payout oracle measure a world that never happens?
//
// THE QUESTION. `probeMany` (oracle.mjs:147) prices the whole strategy universe inside ONE Multicall3
// aggregate3, laid out [bal, harvest_1, bal, harvest_2, bal, ...], and reads each contract's payout as
// the delta across its own pair of balance reads. That is what makes "probe everything before
// spending a slot" affordable — 241 contracts for ~10 requests, free, forever. Its own docstring is
// honest about the catch: calls share state, so harvest_50 executes in a world where 49 other
// harvests have already run.
//
// But ZERO does not harvest 49 strategies. It harvests exactly ONE, from clean state. So every number
// the oracle produces except the first is measured in a counterfactual — and those numbers are what
// choose which strategy gets the scarce relay slot. If shared state distorts them, ZERO is ranking on
// fiction. This matters concretely: `callReward()` was already caught reporting 4,481x what it pays,
// and this oracle is the instrument that replaced it.
//
// THE TEST. Price N strategies the way ZERO does (batched, shared state), then price each one ALONE
// in its own eth_call from clean state, and compare. Isolated is ground truth: it is exactly the
// transaction ZERO would actually send.
//
// Read-only: every call is eth_call. No gas, no slot, no signature, no state change.
import { ethers } from 'ethers';
import fs from 'node:fs';

const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH = '0x4200000000000000000000000000000000000006';
const N = Number(process.env.N || 40);

const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
const HARVEST = new ethers.Interface(['function harvest(address)']);
const balOf = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');
const p = new ethers.JsonRpcProvider(RPC);

const vaultI = new ethers.Interface(['function strategy() view returns (address)']);

async function agg(calls) {
  const ret = await p.call({ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) });
  return AGG.decodeFunctionResult('aggregate3', ret)[0];
}

// ---- resolve strategies exactly as ZERO does
const vaults = JSON.parse(fs.readFileSync(new URL('../_beefy_base.json', import.meta.url), 'utf8'))
  .filter((v) => v.status === 'active' && v.earnContractAddress)
  .slice(0, N);

const sres = await agg(
  vaults.map((v) => ({ target: v.earnContractAddress, allowFailure: true, callData: vaultI.encodeFunctionData('strategy') })),
);
const strategies = [];
sres.forEach((r, i) => {
  if (!r.success || r.returnData === '0x') return;
  try {
    const [a] = vaultI.decodeFunctionResult('strategy', r.returnData);
    if (a && a !== ethers.ZeroAddress) strategies.push({ id: vaults[i].id, addr: a });
  } catch {}
});
console.log(`resolved ${strategies.length} strategies\n`);

const data = HARVEST.encodeFunctionData('harvest', [MULTICALL3]);

// ---- (A) BATCHED, exactly ZERO's probeMany layout: one aggregate3, shared state
const calls = [{ target: WETH, allowFailure: true, callData: balOf(MULTICALL3) }];
for (const s of strategies) {
  calls.push({ target: s.addr, allowFailure: true, callData: data });
  calls.push({ target: WETH, allowFailure: true, callData: balOf(MULTICALL3) });
}
const rows = await agg(calls);
const batched = new Map();
for (let k = 0; k < strategies.length; k++) {
  const before = rows[k * 2], call = rows[1 + k * 2], after = rows[2 + k * 2];
  if (!call?.success || !before?.success || !after?.success) continue;
  try {
    const d = BigInt(after.returnData) - BigInt(before.returnData);
    batched.set(strategies[k].addr, d);
  } catch {}
}

// ---- (B) ISOLATED: each strategy in its OWN aggregate3, from clean state. Ground truth.
const isolated = new Map();
for (const s of strategies) {
  try {
    const r = await agg([
      { target: WETH, allowFailure: true, callData: balOf(MULTICALL3) },
      { target: s.addr, allowFailure: true, callData: data },
      { target: WETH, allowFailure: true, callData: balOf(MULTICALL3) },
    ]);
    if (r[0]?.success && r[1]?.success && r[2]?.success) {
      isolated.set(s.addr, BigInt(r[2].returnData) - BigInt(r[0].returnData));
    }
  } catch {}
}

// ---- compare
let agree = 0, disagree = 0, batchedOnly = 0, isolatedOnly = 0;
const diffs = [];
for (const s of strategies) {
  const b = batched.get(s.addr) ?? 0n;
  const i = isolated.get(s.addr) ?? 0n;
  if (b === i) { if (b > 0n) agree++; continue; }
  if (b > 0n && i === 0n) batchedOnly++;
  else if (i > 0n && b === 0n) isolatedOnly++;
  else disagree++;
  if (b > 0n || i > 0n) {
    const ratio = i > 0n ? Number(b) / Number(i) : Infinity;
    diffs.push({ id: s.id, addr: s.addr, batched: b, isolated: i, ratio });
  }
}

const sum = (m) => [...m.values()].reduce((a, b) => a + (b > 0n ? b : 0n), 0n);
const payersB = [...batched.values()].filter((v) => v > 0n).length;
const payersI = [...isolated.values()].filter((v) => v > 0n).length;

console.log('=== BATCHED (what ZERO ranks on) vs ISOLATED (what ZERO would actually get) ===');
console.log(`strategies probed        : ${strategies.length}`);
console.log(`payers, batched          : ${payersB}`);
console.log(`payers, isolated         : ${payersI}`);
console.log(`total wei, batched       : ${sum(batched)}`);
console.log(`total wei, isolated      : ${sum(isolated)}`);
console.log('');
console.log(`identical                : ${agree}`);
console.log(`pays in BATCH ONLY (phantom income): ${batchedOnly}`);
console.log(`pays in ISOLATION ONLY (missed income): ${isolatedOnly}`);
console.log(`both pay, different amount        : ${disagree}`);

diffs.sort((a, b) => Number(b.isolated - a.isolated));
if (diffs.length) {
  console.log('\ntop divergences (isolated is truth):');
  for (const d of diffs.slice(0, 12)) {
    const r = d.isolated > 0n ? (Number(d.batched) / Number(d.isolated)).toFixed(2) + 'x' : 'batch-only';
    console.log(`  ${d.addr}  batched=${d.batched}  isolated=${d.isolated}  (${r})  ${d.id}`);
  }
}

// ---- the decision that actually matters: does the batch pick the same winner as the truth?
const topB = [...batched.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0];
const topI = [...isolated.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0];
console.log('\n=== THE SLOT DECISION ===');
console.log(`batch would pick : ${topB ? topB[0] + '  (' + topB[1] + ' wei)' : 'nothing'}`);
console.log(`truth would pick : ${topI ? topI[0] + '  (' + topI[1] + ' wei)' : 'nothing'}`);
if (topB && topI) {
  const same = topB[0].toLowerCase() === topI[0].toLowerCase();
  console.log(`SAME WINNER      : ${same ? 'YES — the oracle picks correctly' : 'NO — the oracle sends the slot to the wrong strategy'}`);
  if (!same) {
    const got = isolated.get(topB[0]) ?? 0n;
    const best = topI[1];
    console.log(`cost of the error: picks ${got} wei instead of ${best} wei` +
      (best > 0n ? `  (${((Number(got) / Number(best)) * 100).toFixed(1)}% of the best available)` : ''));
  }
}

fs.writeFileSync(
  new URL('./oracle-distortion.json', import.meta.url),
  JSON.stringify({
    measuredAt: new Date().toISOString(), rpc: RPC, probed: strategies.length,
    payersBatched: payersB, payersIsolated: payersI,
    totalBatched: sum(batched).toString(), totalIsolated: sum(isolated).toString(),
    identical: agree, batchedOnly, isolatedOnly, differentAmount: disagree,
    topBatched: topB ? { addr: topB[0], wei: topB[1].toString() } : null,
    topIsolated: topI ? { addr: topI[0], wei: topI[1].toString() } : null,
    divergences: diffs.slice(0, 25).map((d) => ({ id: d.id, addr: d.addr, batched: d.batched.toString(), isolated: d.isolated.toString() })),
  }, null, 2) + '\n',
);
console.log('\n→ contracts/oracle-distortion.json');
