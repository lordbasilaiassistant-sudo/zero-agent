/* CAN ZERO MINE ITS OWN GAS, TERMINAL-ONLY, IN REAL TIME?
 *
 * SKALE's free-gas chains hand out sFUEL via proof-of-work: find a nonce such that
 * keccak256(abi.encodePacked(address, nonce)) is below a difficulty threshold. That is PURE KECCAK —
 * no custom binary, no SDK, no GPU. ethers already ships keccak256, so if this works it is a gas
 * source with NO COUNTERPARTY: nobody to revoke it, no quota, no company's marketing budget.
 *
 * The measurement that matters is not "does it exist" but "how long does one nonce take" — because
 * gas mined slower than gas spent is not a gas source, it is a hobby.
 */
import { ethers } from 'ethers';

const ADDR = '0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A';

/* SKALE's PoW: valid when uint256(keccak256(address, nonce)) * difficulty < 2^256.
   Equivalent and cheaper to test: hash < (2^256 - 1) / difficulty. */
const MAX = (1n << 256n) - 1n;

function mine(address, difficulty, capMs = 15000) {
  const target = MAX / BigInt(difficulty);
  const t0 = Date.now();
  let nonce = 0n;
  let hashes = 0;
  while (Date.now() - t0 < capMs) {
    const packed = ethers.solidityPacked(['address', 'uint256'], [address, nonce]);
    const h = BigInt(ethers.keccak256(packed));
    hashes++;
    if (h < target) {
      return { found: true, nonce: nonce.toString(), hashes, ms: Date.now() - t0 };
    }
    nonce++;
  }
  return { found: false, hashes, ms: Date.now() - t0 };
}

console.log('address:', ADDR);
console.log('testing whether a valid nonce is findable in pure JS keccak, no custom software\n');

/* Sweep difficulties so we learn the RATE, not just one data point. SKALE's free chains use a low
   difficulty by design — the PoW exists to rate-limit faucet abuse, not to be expensive. */
let rate = 0;
for (const d of [1, 10, 100, 1000, 10000, 100000, 1000000]) {
  const r = mine(ADDR, d, 4000);
  if (r.found) {
    rate = Math.max(rate, Math.round(r.hashes / (r.ms / 1000 || 1)));
    console.log(`difficulty ${String(d).padStart(8)} → nonce found in ${String(r.ms).padStart(5)}ms after ${String(r.hashes).padStart(8)} hashes`);
  } else {
    console.log(`difficulty ${String(d).padStart(8)} → NOT found in ${r.ms}ms (${r.hashes} hashes tried)`);
  }
}

console.log(`\nmeasured hash rate: ~${rate.toLocaleString()} keccak/sec in plain Node, single core, no deps beyond ethers`);
console.log('\nVERDICT INPUTS:');
console.log('  · gas price on SKALE mainnet chains: 100,000 wei (measured this session)');
console.log('  · a simple transfer at 21,000 gas therefore costs 2,100,000,000 wei of sFUEL');
console.log('  · so the question is whether one mined nonce yields enough sFUEL to cover that');
