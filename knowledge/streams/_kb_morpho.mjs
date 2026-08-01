// The Morpho-family question from the brief: these strategies read callReward()==0 yet DO pay.
// Characterise the family so ZERO can find more of it: for each, read callReward(), then run the
// ISOLATED payment test naming ZERO's Safe as the fee recipient, across a token basket.
import { rpc, sel, addrArg, tryCall, dec, probeIsolated, probeCanonical, ZERO_SAFE, MULTICALL3, pin, pinnedDec, interfaceOf } from './_kb_lib.mjs';
import fs from 'fs';

const beefy = JSON.parse(fs.readFileSync('_beefy_base.json', 'utf8'));
const arr = Array.isArray(beefy) ? beefy : (beefy.vaults || Object.values(beefy));
const TOKENS = [
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' },
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
  { symbol: 'MORPHO', address: '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842' },
  { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
  { symbol: 'EURC', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' },
];
await pin('base');
console.log('base @', pinnedDec('base'));

const families = {};
for (const v of arr) {
  if (v.status !== 'active') continue;
  (families[v.platformId || '?'] ||= []).push(v);
}
console.log('platform families:', Object.entries(families).map(([k, v]) => `${k}:${v.length}`).join(' '));

// Probe the Morpho family in full, plus a sample of every other family, ISOLATED.
const rows = [];
const targets = [];
for (const [fam, list] of Object.entries(families)) {
  const take = fam === 'morpho' ? list : list.slice(0, 6);
  for (const v of take) if (v.strategy) targets.push({ fam, id: v.id, strat: v.strategy });
}
console.log('probing', targets.length, 'strategies ISOLATED (one aggregate3 each)\n');

for (const t of targets) {
  const cr = dec(await tryCall('base', t.strat, sel('callReward()')) || '0x');
  const cd = sel('harvest(address)') + addrArg(ZERO_SAFE);
  const r = await probeIsolated('base', t.strat, cd, ZERO_SAFE, TOKENS);
  const paid = r.ok && r.pays ? r.deltas : [];
  if (paid.length) {
    const best = paid.reduce((m, d) => (BigInt(d.wei) > BigInt(m.wei) ? d : m));
    rows.push({ ...t, callReward: cr?.toString() ?? null, wei: best.wei, token: best.token, tokenAddr: best.address, all: paid });
    console.log(`PAYS ${t.fam.padEnd(12)} ${t.strat} callReward=${cr?.toString() ?? 'n/a'} -> ${best.wei} ${best.token}  (${t.id})`);
  }
}
rows.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
console.log('\n=== ISOLATED PAYERS by family ===');
const byFam = {};
for (const r of rows) (byFam[r.fam] ||= []).push(r);
for (const [f, l] of Object.entries(byFam)) console.log(f, l.length, 'payers, total wei', l.reduce((s, x) => s + BigInt(x.wei), 0n).toString());
fs.writeFileSync('knowledge/streams/_kb_morpho_results.json', JSON.stringify(rows, null, 2));
