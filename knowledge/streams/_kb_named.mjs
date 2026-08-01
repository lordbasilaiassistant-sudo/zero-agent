// Evidence (not assertion) for the remaining named families in the lane brief.
import { rpc, sel, addrArg, u256, tryCall, dec, interfaceOf, has, probeIsolated, MULTICALL3, ZERO_SAFE, pin, pinnedDec } from './_kb_lib.mjs';
import { ethers } from 'ethers';

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
const TOK = [{ symbol: 'WETH', address: WETH }, { symbol: 'USDC', address: USDC }, { symbol: 'AERO', address: AERO }];
await pin('base');
console.log('base @', pinnedDec('base'), '\n');

const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const COMET_USDC = '0xb125E6687d4313864e53df431d5425969c15Eb2F';
const AERO_VOTER = '0x16613524e02ad97eDfEF371bC883F2F5d6C480A5';

async function shot(label, chain, target, callData, origin) {
  const a = await probeIsolated(chain, target, callData, MULTICALL3, TOK, 'latest', origin ? { origin: MULTICALL3 } : {});
  let reason = '';
  if (!a.ok) { try { await rpc(chain, 'eth_call', [{ to: target, from: MULTICALL3, data: callData }, 'latest']); reason = '(direct: OK)'; } catch (e) { reason = '(direct: ' + String(e.message).slice(0, 70) + ')'; } }
  console.log(`${label.padEnd(46)} ${a.ok ? (a.pays ? 'PAYS ' + JSON.stringify(a.deltas) : 'callable, pays 0') : 'revert'} ${reason}`);
  return a;
}

// --- AAVE: liquidationCall. Rule (a) says principal must be zero; measure whether it is.
const liq = new ethers.Interface(['function liquidationCall(address,address,address,uint256,bool)']);
await shot('aave v3 liquidationCall(max, healthy user)', 'base', AAVE_POOL,
  liq.encodeFunctionData('liquidationCall', [WETH, USDC, '0x0000000000000000000000000000000000000001', ethers.MaxUint256, false]));
const aaveIface = await interfaceOf('base', AAVE_POOL);
console.log('  aave pool exposes mintToTreasury:', has(aaveIface.hay, 'mintToTreasury(address[])'),
  '· rebalanceStableBorrowRate:', has(aaveIface.hay, 'rebalanceStableBorrowRate(address,address)'));
await shot('aave mintToTreasury([USDC])', 'base', AAVE_POOL,
  new ethers.Interface(['function mintToTreasury(address[])']).encodeFunctionData('mintToTreasury', [[USDC]]));

// --- COMPOUND v3: absorb() is permissionless and needs no capital. Does it PAY?
const ci = await interfaceOf('base', COMET_USDC);
console.log('\ncomet selectors', ci.selectors.length, '· absorb:', has(ci.hay, 'absorb(address,address[])'),
  '· buyCollateral:', has(ci.hay, 'buyCollateral(address,uint256,uint256,address)'), '· accrueAccount:', has(ci.hay, 'accrueAccount(address)'));
await shot('comet absorb(self,[0x1])', 'base', COMET_USDC,
  new ethers.Interface(['function absorb(address,address[])']).encodeFunctionData('absorb', [MULTICALL3, ['0x0000000000000000000000000000000000000001']]));
await shot('comet accrueAccount(MC3)', 'base', COMET_USDC,
  new ethers.Interface(['function accrueAccount(address)']).encodeFunctionData('accrueAccount', [MULTICALL3]));

// --- AERODROME voter/gauge maintenance
const vi = await interfaceOf('base', AERO_VOTER);
console.log('\nvoter selectors', vi.selectors.length, '· distribute():', has(vi.hay, 'distribute()'),
  '· distribute(uint256,uint256):', has(vi.hay, 'distribute(uint256,uint256)'), '· length():', has(vi.hay, 'length()'));
await shot('aerodrome Voter.distribute()', 'base', AERO_VOTER, sel('distribute()'));
await shot('aerodrome Voter.distribute(0,5)', 'base', AERO_VOTER, sel('distribute(uint256,uint256)') + u256(0) + u256(5));

// --- generic permissionless maintenance verbs on the Voter and Comet
for (const s of ['poke()', 'update()', 'sync()', 'checkpoint()', 'kick()', 'crank()', 'skim()', 'gulp()']) {
  for (const [n, t] of [['voter', AERO_VOTER], ['comet', COMET_USDC]]) {
    const ifc = n === 'voter' ? vi : ci;
    if (has(ifc.hay, s)) await shot(`${n}.${s}`, 'base', t, sel(s));
  }
}
