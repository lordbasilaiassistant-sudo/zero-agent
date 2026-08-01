// Two things at once:
//  (A) The reinvest() family found by mining Optimism (Tarot-shape: pays msg.sender a REINVEST_BOUNTY).
//      Characterise it, read its bounty parameter, get the real revert reason, and find siblings.
//  (B) The harvest(address) pool on chains ZERO does not currently work — measured, not assumed.
import { rpc, sel, addrArg, u256, tryCall, dec, decAddr, interfaceOf, has,
  probeIsolated, probeCanonical, MULTICALL3, ZERO_SAFE, pin, pinnedDec } from './_kb_lib.mjs';
import { ethers } from 'ethers';
import fs from 'fs';

const REINVESTERS = {
  optimism: ['0x80942a0066f72efff5900cf80c235dd32549b75d', '0x3b749be6ca33f27e2837138ede69f8c6c53f9207',
    '0xbccdd9e6bc7fe6e59bbca6d8475572f2d0c48726', '0x7aaf3992d0cf903e5288850c661b582365caf512'],
};
console.log('=== (A) reinvest() family on optimism ===');
await pin('optimism');
for (const c of REINVESTERS.optimism) {
  const iface = await interfaceOf('optimism', c);
  const reads = {};
  for (const g of ['REINVEST_BOUNTY()', 'reinvestBounty()', 'factory()', 'underlying()', 'rewardsToken()',
    'getReward()', 'symbol()', 'name()', 'borrowable()', 'collateral()', 'router()']) {
    if (!has(iface.hay, g)) continue;
    const v = await tryCall('optimism', c, sel(g));
    if (v) reads[g] = v.length > 66 ? v.slice(0, 66) + '…' : v;
  }
  let reason = 'n/a';
  try { await rpc('optimism', 'eth_call', [{ to: c, from: MULTICALL3, data: sel('reinvest()') }, 'latest']); reason = 'DOES NOT REVERT'; }
  catch (e) { reason = String(e.message).slice(0, 90); }
  console.log(`\n${c}  selectors=${iface.selectors.length} impl=${iface.impl}`);
  console.log('  reinvest() ->', reason);
  for (const [k, v] of Object.entries(reads)) console.log('   ', k, v);
}

console.log('\n\n=== (B) harvest(address) pool on the chains ZERO does not work ===');
const CH = { optimism: 10, arbitrum: 42161, polygon: 137 };
const WNATIVE = {
  optimism: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
};
const summary = {};
for (const [chain, id] of Object.entries(CH)) {
  let vaults = [];
  try {
    const r = await fetch(`https://api.beefy.finance/vaults/${chain}`);
    vaults = (await r.json()).filter(v => v.status === 'active' && v.strategy);
  } catch (e) { console.log(chain, 'vault list fetch failed', e.message); continue; }
  await pin(chain);
  console.log(`\n--- ${chain} @${pinnedDec(chain)} · ${vaults.length} active strategies (ISOLATED probe each) ---`);
  const tokens = [{ symbol: 'WNATIVE', address: WNATIVE[chain] }];
  const rows = [];
  let n = 0;
  for (const v of vaults) {
    n++;
    const r = await probeIsolated(chain, v.strategy, sel('harvest(address)') + addrArg(ZERO_SAFE), ZERO_SAFE, tokens);
    if (r.ok && r.pays) rows.push({ id: v.id, platform: v.platformId, strategy: v.strategy, wei: r.deltas[0].wei });
    if (n % 60 === 0) process.stdout.write(`.${n}`);
  }
  rows.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
  const tot = rows.reduce((s, x) => s + BigInt(x.wei), 0n);
  summary[chain] = { block: pinnedDec(chain), probed: vaults.length, payers: rows.length, totalWei: tot.toString(), top: rows.slice(0, 10) };
  console.log(`\n  payers ${rows.length}/${vaults.length}  total ${tot} wei (${ethers.formatEther(tot)} native)`);
  for (const x of rows.slice(0, 8)) console.log(`    ${x.wei.padStart(16)} ${x.platform.padEnd(14)} ${x.strategy} ${x.id}`);
}
fs.writeFileSync('knowledge/streams/_kb_multichain.json', JSON.stringify(summary, null, 2));
console.log('\nSUMMARY', JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { payers: v.payers, totalWei: v.totalWei }])), null, 1));
