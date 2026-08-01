// The reinvest() family: REINVEST_BOUNTY()=2e16 (2%), pays msg.sender, gas 0.8-2.7M — the exact
// gas-asymmetric shape ZERO's moat is built on. Enumerate siblings from the factory and run the
// ISOLATED payment test on every one.
import { rpc, sel, addrArg, u256, tryCall, dec, decAddr, interfaceOf, has, extractSelectors, codeOf,
  probeIsolated, probeCanonical, MULTICALL3, ZERO_SAFE, AGG, pin, pinnedDec } from './_kb_lib.mjs';
import { ethers } from 'ethers';
import fs from 'fs';

const SEEDS = {
  optimism: { known: ['0x80942a0066f72efff5900cf80c235dd32549b75d', '0x3b749be6ca33f27e2837138ede69f8c6c53f9207', '0xbccdd9e6bc7fe6e59bbca6d8475572f2d0c48726'],
    factory: '0xbcb9da603a0a53272b61cb84ac0163ec8abc89c5', reward: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', wnative: '0x4200000000000000000000000000000000000006' },
};

for (const [chain, s] of Object.entries(SEEDS)) {
  await pin(chain);
  console.log(`=== ${chain} @${pinnedDec(chain)} reinvest() family ===`);
  // factory interface -> how do we enumerate?
  const fi = await interfaceOf(chain, s.factory);
  console.log('factory selectors:', fi.selectors.length, 'impl', fi.impl);
  for (const g of ['allVaultsLength()', 'allVaults(uint256)', 'allLendingPoolsLength()', 'getVault(address)',
    'allLendingPools(uint256)', 'lendingPoolsLength()', 'getLendingPool(address)', 'router()', 'owner()']) {
    if (has(fi.hay, g)) console.log('  factory has', g);
  }
  let vaults = [...s.known];
  const lenHex = await tryCall(chain, s.factory, sel('allVaultsLength()'));
  const len = lenHex ? Number(dec(lenHex)) : 0;
  console.log('allVaultsLength =', len);
  if (len > 0) {
    const calls = [...Array(len).keys()].map(i => ({ target: s.factory, allowFailure: true, callData: sel('allVaults(uint256)') + u256(i) }));
    for (let i = 0; i < calls.length; i += 80) {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls.slice(i, i + 80)]) }, 'latest']).catch(() => null);
      if (!ret) continue;
      const [rows] = AGG.decodeFunctionResult('aggregate3', ret);
      for (const r of rows) if (r.success && r.returnData.length >= 66) {
        const a = ethers.getAddress('0x' + r.returnData.slice(-40));
        if (!/^0x0+$/i.test(a)) vaults.push(a);
      }
    }
  }
  vaults = [...new Set(vaults.map(v => v.toLowerCase()))];
  console.log('candidate vaults:', vaults.length);

  const results = [];
  for (const v of vaults) {
    // underlying + rewardsToken per vault so we measure the right asset
    const [u, rw] = await Promise.all([tryCall(chain, v, sel('underlying()')), tryCall(chain, v, sel('rewardsToken()'))]);
    const tokens = [{ symbol: 'WNATIVE', address: s.wnative }, { symbol: 'REWARD', address: s.reward }];
    if (u && u.length >= 66) { const a = '0x' + u.slice(-40); if (!/^0x0+$/i.test(a)) tokens.push({ symbol: 'UNDERLYING', address: ethers.getAddress(a) }); }
    if (rw && rw.length >= 66) { const a = '0x' + rw.slice(-40); if (!/^0x0+$/i.test(a) && a.toLowerCase() !== s.reward.toLowerCase()) tokens.push({ symbol: 'REWARD2', address: ethers.getAddress(a) }); }
    tokens.push({ symbol: 'SELF', address: ethers.getAddress(v) });
    const r = await probeIsolated(chain, v, sel('reinvest()'), MULTICALL3, tokens);
    if (r.ok && r.pays) {
      const best = r.deltas.reduce((m, d) => (BigInt(d.wei) > BigInt(m.wei) ? d : m));
      results.push({ chain, vault: v, wei: best.wei, token: best.token, tokenAddr: best.address, all: r.deltas, block: pinnedDec(chain) });
      console.log(`  PAYS ${v} -> ${best.wei} ${best.token} ${best.address}`);
    } else if (r.ok) {
      console.log(`  ${v} callable, pays 0 (state-dependent: reinvest() has nothing accrued yet)`);
    }
  }
  results.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
  console.log('\nISOLATED PAYERS:', results.length, 'total', results.reduce((s, r) => s + BigInt(r.wei), 0n).toString());
  fs.writeFileSync(`knowledge/streams/_kb_tarot_${chain}.json`, JSON.stringify(results, null, 2));
}
