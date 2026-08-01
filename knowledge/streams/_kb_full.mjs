// Full isolated sweep of every active Base strategy with harvest(address)->ZERO's Safe, plus the
// control that proves the delta is really a payment to the NAMED recipient and not ambient noise.
import { rpc, sel, addrArg, tryCall, dec, probeIsolated, probeCanonical, ZERO_SAFE, MULTICALL3, pin, pinnedDec } from './_kb_lib.mjs';
import { ethers } from 'ethers';
import fs from 'fs';

const beefy = JSON.parse(fs.readFileSync('_beefy_base.json', 'utf8'));
const arr = (Array.isArray(beefy) ? beefy : (beefy.vaults || Object.values(beefy))).filter(v => v.status === 'active' && v.strategy);
const WETH = '0x4200000000000000000000000000000000000006';
const TOKENS = [{ symbol: 'WETH', address: WETH }];
const DECOY = '0x000000000000000000000000000000000000dEaD'; // control recipient: nobody

await pin('base');
const BLOCK = pin.block || 'latest';
console.log('base @', pinnedDec('base'), '· strategies:', arr.length);

// ---------- CONTROL ----------
// Same strategy, three recipients. If the delta follows the NAMED recipient, the mechanism is real.
const T = '0xD90ec9e27c47FDF0f766c0D6fC4f0f47376dAA47';
for (const [label, rcpt] of [['ZERO_SAFE', ZERO_SAFE], ['DECOY(0xdead)', DECOY], ['MULTICALL3', MULTICALL3]]) {
  const cd = sel('harvest(address)') + addrArg(rcpt);
  const c = await probeCanonical('base', T, cd, rcpt, WETH);
  console.log(`CONTROL harvest(${label}) measured on ${label}: ${JSON.stringify(c)}`);
}
// cross-control: name the DECOY but measure ZERO's Safe -> must be 0
{
  const cd = sel('harvest(address)') + addrArg(DECOY);
  const c = await probeCanonical('base', T, cd, ZERO_SAFE, WETH);
  console.log(`CONTROL harvest(DECOY) measured on ZERO_SAFE (must be 0): ${JSON.stringify(c)}`);
}

// ---------- FULL SWEEP ----------
const rows = [];
let n = 0;
for (const v of arr) {
  n++;
  const cd = sel('harvest(address)') + addrArg(ZERO_SAFE);
  const r = await probeIsolated('base', v.strategy, cd, ZERO_SAFE, TOKENS);
  if (r.ok && r.pays) {
    const w = r.deltas[0].wei;
    const cr = dec(await tryCall('base', v.strategy, sel('callReward()')) || '0x');
    rows.push({ id: v.id, platform: v.platformId, strategy: v.strategy, wei: w, callReward: cr === null ? null : cr.toString() });
  }
  if (n % 40 === 0) process.stdout.write(`.${n}`);
}
rows.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
const tot = rows.reduce((s, r) => s + BigInt(r.wei), 0n);
const blind = rows.filter(r => r.callReward === '0' || r.callReward === null);
const blindTot = blind.reduce((s, r) => s + BigInt(r.wei), 0n);
console.log(`\n\nISOLATED payers: ${rows.length}/${arr.length}`);
console.log(`total          : ${tot} wei = ${ethers.formatEther(tot)} ETH`);
console.log(`callReward()==0 or missing, yet PAYS: ${blind.length} strategies = ${blindTot} wei (${(Number(blindTot) / Number(tot) * 100).toFixed(1)}% of the pool ZERO's ranking cannot see)`);
console.log('\nTOP 20:');
for (const r of rows.slice(0, 20)) console.log(`  ${r.wei.padStart(16)}  cr=${String(r.callReward).padStart(16)}  ${r.platform.padEnd(12)} ${r.strategy} ${r.id}`);
const byPlat = {};
for (const r of rows) { (byPlat[r.platform] ||= { n: 0, wei: 0n, blind: 0 }); byPlat[r.platform].n++; byPlat[r.platform].wei += BigInt(r.wei); if (r.callReward === '0') byPlat[r.platform].blind++; }
console.log('\nBY PLATFORM: ', Object.entries(byPlat).map(([k, v]) => `${k}=${v.n}p/${v.blind}blind/${v.wei}wei`).join('  '));
fs.writeFileSync('knowledge/streams/_kb_full_base.json', JSON.stringify({ block: pinnedDec('base'), total: tot.toString(), blindTotal: blindTot.toString(), rows }, null, 2));
