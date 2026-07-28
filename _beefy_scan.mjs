import { ethers } from 'ethers';
import fs from 'node:fs';

const p = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com');
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc = new ethers.Contract(MC, ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])'], p);
const vaults = JSON.parse(fs.readFileSync('_beefy_base.json', 'utf8'));

const iVault = new ethers.Interface(['function strategy() view returns (address)']);
const iStrat = new ethers.Interface(['function callReward() view returns (uint256)', 'function harvest(address) external', 'function native() view returns (address)']);

async function batch(calls, SZ=60) {
  const out = [];
  for (let i = 0; i < calls.length; i += SZ) { try { out.push(...await mc.aggregate3.staticCall(calls.slice(i, i + SZ))); } catch(e){ for(let k=0;k<Math.min(SZ,calls.length-i);k++) out.push({success:false,returnData:"0x"}); } }
  return out;
}

const sres = await batch(vaults.map(v => ({ target: v.earnContractAddress, allowFailure: true, callData: iVault.encodeFunctionData('strategy') })));
const strats = [];
sres.forEach((r, i) => { if (r.success && r.returnData !== '0x') { try { strats.push({ id: vaults[i].id, strat: iVault.decodeFunctionResult('strategy', r.returnData)[0] }); } catch {} } });
console.log('strategies found', strats.length);

const cres = await batch(strats.map(s => ({ target: s.strat, allowFailure: true, callData: iStrat.encodeFunctionData('callReward') })), 4);
const rows = [];
cres.forEach((r, i) => {
  if (r.success && r.returnData !== '0x') {
    try { const v = iStrat.decodeFunctionResult('callReward', r.returnData)[0]; if (v > 0n) rows.push({ ...strats[i], reward: v }); } catch {}
  }
});
rows.sort((a, b) => (b.reward > a.reward ? 1 : -1));
const ethUsd = 3200;
console.log('vaults with callReward>0:', rows.length);
for (const r of rows.slice(0, 15)) {
  console.log(r.id, r.strat, ethers.formatEther(r.reward), 'native  ~$' + (Number(ethers.formatEther(r.reward)) * ethUsd).toFixed(4));
}
