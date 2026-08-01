// Aura BoosterLite — earmarkRewards(pid) pays `earmarkIncentive` to msg.sender. Permissionless?
// Verify on-chain across every chain ZERO can reach.
import { rpc, codeOf, implOf, extractSelectors, has, sel, addrArg, u256, tryCall, dec, decAddr,
  probeIsolated, MULTICALL3, ZERO_SAFE, AGG, balOf } from './_kb_lib.mjs';
import { ethers } from 'ethers';

const BOOSTER = '0x98Ef32edd24e2c92525E59afc4475C1242a30184';
const CHAINS = ['base', 'optimism', 'arbitrum', 'polygon', 'gnosis'];

const REWARD_TOKENS = {
  base:     [{ symbol: 'BAL', address: '0x4158734D47Fc9692176B5085E0F52ee0Da5d47F1' }, { symbol: 'AURA', address: '0x1509706a6c66CA549ff0cB464de88231DDBe213B' }, { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' }],
  optimism: [{ symbol: 'BAL', address: '0xFE8B128bA8C78aabC59d4c64cEE7fF28e9379921' }, { symbol: 'AURA', address: '0x1509706a6c66CA549ff0cB464de88231DDBe213B' }, { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' }],
  arbitrum: [{ symbol: 'BAL', address: '0x040d1EdC9569d4Bab2D15287Dc5A4F10F56a56B8' }, { symbol: 'AURA', address: '0x1509706a6c66CA549ff0cB464de88231DDBe213B' }, { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' }],
  polygon:  [{ symbol: 'BAL', address: '0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3' }, { symbol: 'AURA', address: '0x1509706a6c66CA549ff0cB464de88231DDBe213B' }, { symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' }],
  gnosis:   [{ symbol: 'BAL', address: '0x7eF541E2a22058048904fE5744f9c7E4C57AF717' }, { symbol: 'AURA', address: '0x1509706a6c66CA549ff0cB464de88231DDBe213B' }, { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' }],
};

const out = {};
for (const chain of CHAINS) {
  const code = await codeOf(chain, BOOSTER).catch(() => '0x');
  if (!code || code === '0x') { console.log(chain, 'NO CODE at BoosterLite'); out[chain] = { deployed: false }; continue; }
  const impl = await implOf(chain, BOOSTER);
  const icode = impl ? await codeOf(chain, impl) : '0x';
  const hay = (code + icode).toLowerCase();
  const sels = [...new Set([...extractSelectors(code), ...extractSelectors(icode)])];
  const poolLen = dec(await tryCall(chain, BOOSTER, sel('poolLength()')) || '0x0');
  const inc = dec(await tryCall(chain, BOOSTER, sel('earmarkIncentive()')) || '0x');
  const feeDen = dec(await tryCall(chain, BOOSTER, sel('FEE_DENOMINATOR()')) || '0x');
  const rewardToken = decAddr(await tryCall(chain, BOOSTER, sel('crv()')) || '0x');
  const earmarkOnDeposit = await tryCall(chain, BOOSTER, sel('earmarkOnDeposit()'));
  console.log(`\n=== ${chain} BoosterLite ===`);
  console.log('  codeSize', (code.length - 2) / 2, 'impl', impl, 'selectors', sels.length);
  console.log('  poolLength', poolLen?.toString(), 'earmarkIncentive', inc?.toString(), '/', feeDen?.toString(),
    'crv(reward)', rewardToken, 'earmarkOnDeposit', earmarkOnDeposit);
  console.log('  has earmarkRewards(uint256)      ', has(hay, 'earmarkRewards(uint256)'));
  console.log('  has earmarkRewards(uint256,address)', has(hay, 'earmarkRewards(uint256,address)'));
  console.log('  has earmarkRewards(uint256,address,address)', has(hay, 'earmarkRewards(uint256,address,address)'));
  out[chain] = { deployed: true, impl, poolLength: poolLen?.toString(), inc: inc?.toString(), feeDen: feeDen?.toString(), rewardToken, sels: sels.length };
}
console.log('\nSUMMARY', JSON.stringify(out, null, 1));
