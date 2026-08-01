// Ajna: kickReserveAuction() pays the caller a share of claimable reserves. No capital, permissionless.
// Enumerate every pool from the factory on-chain, screen, then ISOLATE each hit.
import { rpc, sel, addrArg, u256, codeOf, extractSelectors, has, tryCall, dec,
  probeIsolated, probeCanonical, MULTICALL3, AGG, balOf, pin, pinnedDec } from './_kb_lib.mjs';
import { ethers } from 'ethers';
import fs from 'fs';

const FACTORY = {
  base:     '0x214f62B5836D83f3D6c4f71F174209097B1A779C',
  arbitrum: '0xA3A1e968Bd6C578205E11256c8e6929f21742aAF',
  optimism: '0x609C4e8804fafC07c96bE81A8a98d0AdCf2b7Dfa',
  polygon:  '0x1f172F881eBa06Aa7a991651780527C173783Cf6',
  gnosis:   '0x87578E357358163FCAb1711c62AcDB5BBFa1C9ef',
};
const iface = new ethers.Interface([
  'function getDeployedPoolsList() view returns (address[])',
  'function getNumberOfDeployedPools() view returns (uint256)',
  'function quoteTokenAddress() view returns (address)',
  'function collateralAddress() view returns (address)',
  'function reservesInfo() view returns (uint256,uint256,uint256,uint256,uint256)',
]);

const all = [];
for (const [chain, f] of Object.entries(FACTORY)) {
  await pin(chain);
  let pools = [];
  try {
    const r = await rpc(chain, 'eth_call', [{ to: f, data: iface.encodeFunctionData('getDeployedPoolsList') }, 'latest']);
    [pools] = iface.decodeFunctionResult('getDeployedPoolsList', r);
    pools = [...pools];
  } catch (e) { console.log(chain, 'factory list failed', e.message.slice(0, 70)); continue; }
  console.log(`\n=== ${chain} @${pinnedDec(chain)} — ${pools.length} Ajna pools`);
  if (!pools.length) continue;

  // quote token per pool (batched READ — reads are safe to batch)
  const qcalls = pools.map(p => ({ target: p, allowFailure: true, callData: sel('quoteTokenAddress()') }));
  let quotes = [];
  for (let i = 0; i < qcalls.length; i += 60) {
    const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [qcalls.slice(i, i + 60)]) }, 'latest']).catch(() => null);
    if (!ret) { quotes.push(...new Array(Math.min(60, qcalls.length - i)).fill(null)); continue; }
    const [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    quotes.push(...rows.map(r => r.success && r.returnData.length >= 66 ? ethers.getAddress('0x' + r.returnData.slice(-40)) : null));
  }
  // reservesInfo -> claimable reserves per pool (READ)
  const rcalls = pools.map(p => ({ target: p, allowFailure: true, callData: sel('reservesInfo()') }));
  let reserves = [];
  for (let i = 0; i < rcalls.length; i += 60) {
    const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [rcalls.slice(i, i + 60)]) }, 'latest']).catch(() => null);
    if (!ret) { reserves.push(...new Array(Math.min(60, rcalls.length - i)).fill(null)); continue; }
    const [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    reserves.push(...rows.map(r => { try { return r.success ? iface.decodeFunctionResult('reservesInfo', r.returnData) : null; } catch { return null; } }));
  }

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i], q = quotes[i];
    if (!q) continue;
    const tokens = [{ symbol: 'QUOTE', address: q }];
    const r = await probeIsolated(chain, p, sel('kickReserveAuction()'), MULTICALL3, tokens);
    const wei = r.ok && r.pays ? (r.deltas.find(d => d.token === 'QUOTE')?.wei || '0') : '0';
    const claim = reserves[i] ? reserves[i][1]?.toString() : '?';
    const mark = BigInt(wei) > 0n ? ' <<< PAYS' : '';
    console.log(`  ${p} quote ${q.slice(0, 10)} claimable=${claim} kickReserveAuction -> ${r.ok ? (r.pays ? wei : '0 (callable)') : r.reason.slice(0, 40)}${mark}`);
    if (BigInt(wei) > 0n) all.push({ chain, pool: p, quote: q, wei, block: pinnedDec(chain), claimable: claim });
  }
}
all.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
console.log('\nISOLATED PAYERS:', JSON.stringify(all, null, 1));
fs.writeFileSync('knowledge/streams/_kb_ajna_results.json', JSON.stringify(all, null, 2));
