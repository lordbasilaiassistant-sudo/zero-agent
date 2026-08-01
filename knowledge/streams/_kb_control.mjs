// Control test: prove the harness reports TRUE on a known payer and FALSE on the known liar.
import { probeIsolated, probeCanonical, pin, pinnedDec, sel, addrArg, ZERO_SAFE, MULTICALL3 } from './_kb_lib.mjs';

const WETH_BASE = '0x4200000000000000000000000000000000000006';
const TOKENS = [{ symbol: 'WETH', address: WETH_BASE }];

const KNOWN_PAYER = '0x8B45D51e015Dac924EeAEa754e6f768943206F05'; // measured 2687055252441 wei
const KNOWN_LIAR = '0x11dD6940AeA57aAC6aC4D204E13161BB6E5Bf0A8';  // returns ok on every sig, pays 0

await pin('base');
console.log('pinned base block', pinnedDec('base'));

for (const [name, addr] of [['KNOWN_PAYER', KNOWN_PAYER], ['KNOWN_LIAR', KNOWN_LIAR]]) {
  // harvest(address) with ZERO's Safe named as the fee recipient
  const cd = sel('harvest(address)') + addrArg(ZERO_SAFE);
  const r = await probeIsolated('base', addr, cd, ZERO_SAFE, TOKENS);
  console.log(name, 'harvest(address)->SAFE', JSON.stringify(r));
  // harvest() paying msg.sender == Multicall3
  const r2 = await probeIsolated('base', addr, sel('harvest()'), MULTICALL3, TOKENS);
  console.log(name, 'harvest()->MULTICALL3', JSON.stringify(r2));
  const c = await probeCanonical('base', addr, cd, ZERO_SAFE, WETH_BASE).catch(e => ({ err: e.message }));
  console.log(name, 'canonical3', JSON.stringify(c));
}
