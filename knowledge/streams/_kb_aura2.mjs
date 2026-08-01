// Screen every Aura pid for earmarkRewards payment, then ISOLATE each hit.
import { rpc, sel, addrArg, u256, probeIsolated, probeCanonical, MULTICALL3, AGG, balOf, pin, pinnedDec } from './_kb_lib.mjs';
import { ethers } from 'ethers';
import fs from 'fs';

const BOOSTER = '0x98Ef32edd24e2c92525E59afc4475C1242a30184';
const CFG = {
  base:     { pools: 29,  bal: '0x4158734D47Fc9692176B5085E0F52ee0Da5d47F1' },
  optimism: { pools: 35,  bal: '0xFE8B128bA8C78aabC59d4c64cEE7fF28e9379921' },
  arbitrum: { pools: 109, bal: '0x040d1EdC9569d4Bab2D15287Dc5A4F10F56a56B8' },
  polygon:  { pools: 32,  bal: '0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3' },
  gnosis:   { pools: 36,  bal: '0x7eF541E2a22058048904fE5744f9c7E4C57AF717' },
};
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const cdEarmark = (pid) => sel('earmarkRewards(uint256,address)') + u256(pid) + addrArg(ZERO_ADDR);

const results = [];
for (const [chain, cfg] of Object.entries(CFG)) {
  await pin(chain);
  const tokens = [{ symbol: 'BAL', address: cfg.bal }];
  // ---- SCREEN (shared state, ranking only) ----
  const pids = [...Array(cfg.pools).keys()];
  const screened = [];
  for (let i = 0; i < pids.length; i += 20) {
    const slice = pids.slice(i, i + 20);
    const calls = [{ target: cfg.bal, allowFailure: true, callData: balOf(MULTICALL3) }];
    for (const p of slice) {
      calls.push({ target: BOOSTER, allowFailure: true, callData: cdEarmark(p) });
      calls.push({ target: cfg.bal, allowFailure: true, callData: balOf(MULTICALL3) });
    }
    let rows;
    try {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
      [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    } catch (e) { console.log(chain, 'screen batch failed', e.message.slice(0, 60)); continue; }
    for (let k = 0; k < slice.length; k++) {
      const b = rows[k * 2], c = rows[1 + k * 2], a = rows[2 + k * 2];
      if (!c?.success) continue;
      let d = 0n; try { d = BigInt(a.returnData) - BigInt(b.returnData); } catch {}
      screened.push({ pid: slice[k], wei: d });
    }
  }
  const callable = screened.length;
  const cands = screened.filter(s => s.wei > 0n).sort((a, b) => (b.wei > a.wei ? 1 : -1));
  console.log(`\n=== ${chain} @${pinnedDec(chain)} — ${cfg.pools} pools · ${callable} callable · ${cands.length} screened-positive`);

  // ---- ISOLATE every screened-positive candidate, one aggregate3 each ----
  for (const c of cands) {
    const r = await probeIsolated(chain, BOOSTER, cdEarmark(c.pid), MULTICALL3, tokens);
    const wei = r.ok && r.pays ? r.deltas.find(d => d.token === 'BAL')?.wei : '0';
    console.log(`  pid ${String(c.pid).padStart(3)}  screen ${c.wei.toString().padStart(22)}  ISOLATED ${String(wei || 0).padStart(22)}`);
    if (r.ok && r.pays && BigInt(wei) > 0n) results.push({ chain, pid: c.pid, wei, token: 'BAL', tokenAddr: cfg.bal, block: pinnedDec(chain) });
  }
}
results.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
console.log('\nISOLATED PAYERS:', JSON.stringify(results, null, 1));
fs.writeFileSync('knowledge/streams/_kb_aura_results.json', JSON.stringify(results, null, 2));
