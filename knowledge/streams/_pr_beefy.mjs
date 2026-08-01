import fs from 'fs';
import { rpc, settersPresent, simulateSetterFromSafe } from './_pr_probe.mjs';
import { ethers } from 'ethers';

// Read Beefy Base vault universe; for a sample, resolve strategy() and scan the STRATEGY (where fees live)
const vaults = JSON.parse(fs.readFileSync('../../_beefy_base.json'))
  .filter(v => v.status === 'active' && v.earnContractAddress)
  .slice(0, 45);

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const stratSel = ethers.id('strategy()').slice(0,10);
let openFound = 0, scanned = 0, errs = 0;
for (const v of vaults) {
  await sleep(250);
  const s = await rpc('base','eth_call',[{to:v.earnContractAddress,data:stratSel},'latest']);
  if (s && s.__error) { errs++; continue; }
  const strat = (typeof s==='string' && s.length>=42) ? '0x'+s.slice(-40) : null;
  if (!strat || /^0x0+$/.test(strat)) continue;
  await sleep(250);
  const sp = await settersPresent('base', strat);
  scanned++;
  if (!sp.present.length) continue;
  // simulate each setter from Safe
  const results = [];
  for (const p of sp.present) {
    const sim = await simulateSetterFromSafe('base', strat, p.sig);
    results.push(`${p.sig}:${sim.callable?'OPEN*':'gated'}`);
    if (sim.callable) openFound++;
  }
  const anyOpen = results.some(r=>r.includes('OPEN'));
  if (anyOpen) console.log(`OPEN SETTER  ${v.id}  strat=${strat}  ${results.join(' ')}`);
}
console.log(`\nscanned ${scanned} strategies; rpc-errors ${errs}; open-setter hits: ${openFound}`);

// A few more referral storages beyond GMX
const OTHER = [
  ['arbitrum','0x1a64c530d88a4a71c2feb7cf3f0a91f37bd97e5c','MUX? guess'],
  ['optimism','0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4','Synthetix? guess'],
];
for (const [chain,addr,label] of OTHER) {
  const sp = await settersPresent(chain, addr).catch(()=>({isContract:false,present:[]}));
  if (!sp.isContract) { console.log(`${label} ${addr}: not a contract`); continue; }
  console.log(`${label} ${addr}: setters ${sp.present.map(p=>p.sig).join(',')||'(none)'}`);
}
console.log('DONE');
