import { tokenVerdict, transferSimOk, isLiveOwnedAddress } from './janitor.mjs';
const pass = [], fail = [];
const check = (n, c) => (c ? pass : fail).push(n);
// CONTROL 1: the real-world specimen must condemn
check('optibase bait symbol condemns', tokenVerdict('optibase.website 🟢', 'optibase.website 🧲 claim airdrop') === 'junk');
check('claim-bait name condemns', tokenVerdict('$FOO', 'claim your airdrop at evil.xyz') === 'junk');
// CONTROL 2 (the guard that must NOT fire): legitimate assets stay undecided → liquidity decides
check('WETH is not name-condemned', tokenVerdict('WETH', 'Wrapped Ether') === null);
check('USDC is not name-condemned', tokenVerdict('USD Coin', 'USD Coin') === null);
check('Beefy-adjacent real token not condemned', tokenVerdict('VELO', 'Velodrome') === null);
check('empty transfer return is success', transferSimOk('0x') === true);
check('transfer true is success', transferSimOk('0x0000000000000000000000000000000000000000000000000000000000000001') === true);
check('transfer false is not success', transferSimOk('0x0000000000000000000000000000000000000000000000000000000000000000') === false);
check('Error(string) revert data is not success', transferSimOk('0x08c379a000000000000000000000000000000000000000000000000000000000') === false);
check('retired Safe is not live owned', isLiveOwnedAddress('0x510601f59FDa068D70ad6760c9d9085B0F42cbb1') === false);
check('live Safe is live owned', isLiveOwnedAddress('0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f') === true);
console.log(`${pass.length} passed, ${fail.length} failed` + (fail.length ? ` — FAILED: ${fail.join('; ')}` : ''));
process.exitCode = fail.length ? 1 : 0;
