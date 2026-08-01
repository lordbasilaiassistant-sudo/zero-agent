import { settersPresent, simulateSetterFromSafe, rpc } from './_pr_probe.mjs';

// Curated well-known contracts to test for OPEN persistent-recipient setters.
// Addresses are treated as unverified until bytecode confirms them a contract.
const CANDIDATES = [
  // Base
  ['base','0x420DD381b31aEf6683db6B902084cB0FFECe40Da','Aerodrome PoolFactory'],
  ['base','0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6','Uniswap V2 Factory (Base)'],
  ['base','0x33128a8fC17869897dcE68Ed026d694621f6FDfD','Uniswap V3 Factory (Base)'],
  ['base','0x1B8eea9315bE495187D873DA7773a874545D9D48','SushiSwap V2 Factory (Base)'],
  ['base','0x71524B4f93c58fcbF659783284E38825f0622859','SwapBased?'],
  // Arbitrum
  ['arbitrum','0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d','GMX ReferralStorage'],
  ['arbitrum','0xc35DADB65012eC5796536bD9864eD8773aBc74C4','SushiSwap V2 Factory (Arb)'],
  ['arbitrum','0x6EcCab422D763aC031210895C81787E87B43A652','Camelot V2 Factory'],
  ['arbitrum','0x1F98431c8aD98523631AE4a59f267346ea31F984','Uniswap V3 Factory (Arb)'],
  // Optimism
  ['optimism','0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a','Velodrome V2 PoolFactory'],
  ['optimism','0x1F98431c8aD98523631AE4a59f267346ea31F984','Uniswap V3 Factory (Op)'],
  // Polygon
  ['polygon','0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32','QuickSwap Factory'],
  ['polygon','0xc35DADB65012eC5796536bD9864eD8773aBc74C4','SushiSwap V2 Factory (Poly)'],
  ['polygon','0x1F98431c8aD98523631AE4a59f267346ea31F984','Uniswap V3 Factory (Poly)'],
  // Gnosis
  ['gnosis','0xA818b4F111Ccac7AA31D0BCc0806d64F2E0737D7','Honeyswap Factory'],
];

for (const [chain, addr, label] of CANDIDATES) {
  try {
    const s = await settersPresent(chain, addr);
    if (!s.isContract) { console.log(`\n[${chain}] ${label} ${addr}\n  NOT A CONTRACT (or RPC fail)`); continue; }
    const tag = s.present.length ? s.present.map(p=>p.sig).join(', ') : '(none)';
    console.log(`\n[${chain}] ${label} ${addr}\n  impl=${s.impl||'-'} selectors=${s.allSelCount} setters: ${tag}`);
    for (const p of s.present) {
      const sim = await simulateSetterFromSafe(chain, addr, p.sig);
      console.log(`    ${p.sig} => ${sim.callable ? 'CALLABLE(no revert)*' : 'reverts: '+sim.reason}`);
    }
  } catch (e) {
    console.log(`\n[${chain}] ${label} ${addr}\n  ERROR ${String(e.message).slice(0,100)}`);
  }
}
console.log('\nDONE');
