// selector-audit.mjs — measure how many of ZERO's recovered "selectors" are not selectors at all.
//
// ZERO's bruteforce.mjs recovers a contract's external interface by scanning runtime bytecode for the
// PUSH4 opcode (0x63) and taking the next 4 bytes. The scan steps one byte at a time and never walks
// the instruction stream, so any 0x63 that happens to sit INSIDE the immediate data of another PUSH —
// inside a constant, an address, a hash, or the trailing CBOR metadata blob — is mistaken for an
// opcode and the four bytes after it become a phantom function.
//
// I hit this exact bug tonight in my own bytecode test: a naive byte scan reported DELEGATECALL,
// CREATE and CREATE2 in ZeroHarvester, and all three were inside the 51-byte metadata trailer. The
// lesson generalises, so this measures the same defect where it actually costs something.
//
// Read-only. Compares three recoveries against real Base contracts:
//   naive       — what ZERO does today
//   opcodeAware — walk the instruction stream, stepping over PUSH immediates
//   +metaStrip  — same, with the CBOR metadata trailer removed first
import { ethers } from 'ethers';

const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const p = new ethers.JsonRpcProvider(RPC);

const SKIP = new Set([
  '0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0x70a08231', '0xdd62ed3e',
  '0x01ffc9a7', '0x8da5cb5b', '0x5c60da1b', '0x3644e515', '0x54fd4d50', '0xc45a0155',
  '0x0dfe1681', '0xd21220a7', '0x38d52e0f', '0x7dc0d1d0', '0xfc0c546a', '0x17d7de7c',
  '0xa9059cbb', '0x23b872dd', '0x095ea7b3', '0x40c10f19', '0x42966c68',
]);

/** EXACTLY ZERO's current implementation (bruteforce.mjs:41). */
function naive(code) {
  const out = new Set();
  if (!code || code.length < 10) return [];
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '63') continue;
    const s = '0x' + hex.slice(i + 2, i + 10).toLowerCase();
    if (/^0x0{4,}/.test(s)) continue;
    if (SKIP.has(s)) continue;
    out.add(s);
  }
  return [...out];
}

/** Strip the CBOR metadata trailer solc appends; its last two bytes are its own length. */
function stripMetadata(bytes) {
  if (bytes.length < 3) return bytes;
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const end = bytes.length - 2 - len;
  // sanity: real metadata starts with a CBOR map marker
  if (end > 0 && end < bytes.length && (bytes[end] === 0xa2 || bytes[end] === 0xa3)) return bytes.subarray(0, end);
  return bytes;
}

/** Walk the instruction stream. A PUSHn's immediate bytes are DATA and must be stepped over. */
function opcodeAware(code, { strip = false } = {}) {
  const out = new Set();
  if (!code || code.length < 10) return [];
  let bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
  if (strip) bytes = stripMetadata(bytes);
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    if (op === 0x63 && i + 5 <= bytes.length) {
      const s = '0x' + bytes.subarray(i + 1, i + 5).toString('hex');
      if (!/^0x0{4,}/.test(s) && !SKIP.has(s)) out.add(s);
    }
    i += op >= 0x60 && op <= 0x7f ? op - 0x5f + 1 : 1;
  }
  return [...out];
}

/** Ground truth: a selector that really exists is reachable in the dispatcher. We verify a sample by
 *  eth_call — a phantom selector hits the fallback (or reverts) identically to a real one, so instead
 *  we use the strongest available signal: presence in the VERIFIED ABI where one exists. */
async function verifiedAbiSelectors(addr) {
  try {
    const r = await fetch(`https://base.blockscout.com/api/v2/smart-contracts/${addr}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.abi) return null;
    const out = new Set();
    for (const f of j.abi) {
      if (f.type !== 'function') continue;
      const sig = `${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})`;
      out.add(ethers.id(sig).slice(0, 10));
    }
    return out;
  } catch {
    return null;
  }
}

const TARGETS = [
  ['StrategyRewardPool (215 of 241 Base strategies)', '0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1'],
  ['WETH9', '0x4200000000000000000000000000000000000006'],
  ['Multicall3', '0xcA11bde05977b3631167028862bE2a173976CA11'],
  ['Aerodrome COW strategy', '0x8B45D51e015Dac924EeAEa754e6f768943206F05'],
];

console.log('SELECTOR RECOVERY AUDIT — ZERO bruteforce.mjs:41\n');
let totalNaive = 0, totalAware = 0, totalStrip = 0, totalPhantomConfirmed = 0, totalReal = 0;

for (const [name, addr] of TARGETS) {
  const code = await p.getCode(addr);
  if (code === '0x') {
    console.log(`${name}: no code`);
    continue;
  }
  const n = naive(code);
  const a = opcodeAware(code);
  const s = opcodeAware(code, { strip: true });
  const abi = await verifiedAbiSelectors(addr);

  totalNaive += n.length; totalAware += a.length; totalStrip += s.length;

  console.log(`── ${name}`);
  console.log(`   ${addr}  (${(code.length - 2) / 2} bytes)`);
  console.log(`   naive (today)      : ${n.length}`);
  console.log(`   opcode-aware       : ${a.length}`);
  console.log(`   + metadata stripped: ${s.length}`);
  console.log(`   PHANTOMS from naive: ${n.length - s.length}  (${n.length ? (((n.length - s.length) / n.length) * 100).toFixed(1) : 0}% of what it reports)`);

  if (abi) {
    const inAbi = (x) => abi.has(x);
    const nReal = n.filter(inAbi).length;
    const sReal = s.filter(inAbi).length;
    const nFake = n.length - nReal;
    totalPhantomConfirmed += nFake;
    totalReal += nReal;
    console.log(`   vs VERIFIED ABI (${abi.size} fns): naive ${nReal} real / ${nFake} not-in-abi · strict ${sReal} real / ${s.length - sReal} not-in-abi`);
    const missed = [...abi].filter((x) => !SKIP.has(x) && !s.includes(x));
    if (missed.length) console.log(`   ⚠ strict MISSED ${missed.length} real selectors (would be a regression): ${missed.slice(0, 5).join(' ')}`);
    else console.log(`   ✓ strict missed NOTHING real — pure precision gain, no recall loss`);
  } else {
    console.log(`   (no verified ABI available)`);
  }
  console.log('');
}

console.log('=== TOTALS ===');
console.log(`naive selectors probed      : ${totalNaive}`);
console.log(`opcode-aware                : ${totalAware}`);
console.log(`opcode-aware + meta-strip   : ${totalStrip}`);
console.log(`wasted probes eliminated    : ${totalNaive - totalStrip}  (${totalNaive ? (((totalNaive - totalStrip) / totalNaive) * 100).toFixed(1) : 0}%)`);
if (totalReal) console.log(`confirmed-not-in-ABI (naive): ${totalPhantomConfirmed} of ${totalNaive}`);
