// Why does earmarkRewards revert? Get the real revert reason + confirm the selector set.
import { rpc, sel, addrArg, u256, codeOf, extractSelectors, MULTICALL3, ZERO_SAFE } from './_kb_lib.mjs';
import { ethers } from 'ethers';

const BOOSTER = '0x98Ef32edd24e2c92525E59afc4475C1242a30184';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const chain = 'base';
const code = await codeOf(chain, BOOSTER);
const sels = extractSelectors(code);
// name every selector we can
const NAMES = ['earmarkRewards(uint256,address)','earmarkRewards(uint256)','earmarkIncentive()','poolInfo(uint256)',
  'poolLength()','isShutdown()','crv()','staker()','lockRewards()','rewardFactory()','feeManager()','owner()',
  'setFeeInfo(address,address)','deposit(uint256,uint256,bool)','earmarkFees()','earmarkFees(address)',
  'processIdleRewards()','distributeL2Fees(uint256)','bridgeDelegate()','treasury()','setEarmarkIncentive(uint256)'];
const known = {}; for (const n of NAMES) known[sel(n)] = n;
console.log('named selectors present:');
for (const s of sels) if (known[s]) console.log('  ', s, known[s]);

// revert reason for each variant, direct eth_call from Multicall3-like sender
for (const [label, data] of [
  ['earmarkRewards(uint256,address) pid0', sel('earmarkRewards(uint256,address)') + u256(0) + addrArg(ZERO_ADDR)],
  ['earmarkRewards(uint256,address) pid1', sel('earmarkRewards(uint256,address)') + u256(1) + addrArg(ZERO_ADDR)],
  ['earmarkRewards(uint256,address) pid0 self', sel('earmarkRewards(uint256,address)') + u256(0) + addrArg(MULTICALL3)],
  ['earmarkRewards(uint256) pid0', sel('earmarkRewards(uint256)') + u256(0)],
]) {
  try {
    const r = await rpc(chain, 'eth_call', [{ to: BOOSTER, from: MULTICALL3, data }, 'latest']);
    console.log(label, '-> OK', r.slice(0, 66));
  } catch (e) {
    console.log(label, '-> REVERT:', String(e.message).slice(0, 160));
  }
}
// state reads
for (const s of ['isShutdown()', 'earmarkIncentive()', 'feeManager()', 'bridgeDelegate()', 'treasury()', 'staker()']) {
  try { const r = await rpc(chain, 'eth_call', [{ to: BOOSTER, data: sel(s) }, 'latest']); console.log(s, r); }
  catch (e) { console.log(s, 'ERR', e.message.slice(0, 60)); }
}
// poolInfo(0)
try {
  const r = await rpc(chain, 'eth_call', [{ to: BOOSTER, data: sel('poolInfo(uint256)') + u256(0) }, 'latest']);
  console.log('poolInfo(0)', r);
} catch (e) { console.log('poolInfo err', e.message.slice(0, 80)); }
console.log('\nALL SELECTORS (', sels.length, '):', sels.join(' '));
