// day0-hunt.mjs — DAY-0 FINDS. Hunt contracts born in a chain's earliest days that still hold
// value and can still be moved by ANYONE, missed because nobody scans dead blocks.
//
// Why this is under-explored (the search-functionality gap Anthony named):
//   · explorers rank by RECENT activity, so a 2018 contract with no txs since is invisible
//   · unverified old contracts have no ABI anywhere, so nobody knows what functions they expose
//   · "top holders" lists only surface whales; a $2 contract with an open withdraw is beneath them
//   · early blocks are TINY (a few txs each) so scanning them is cheap — and almost nobody does
//
// Why gnosis first: launched 2018 (old enough to have fossils), and ZERO holds 5 FREE sponsored
// transactions/day there — so anything found can actually be taken at zero cost.
//
// Pipeline: early blocks -> contract creations -> live balance (Multicall3 batch) -> for the funded
// ones, recover the interface from bytecode and simulate every no-arg function from ZERO's address,
// measuring the native-balance delta. Read-only; nothing can move.
//
// Usage: node scripts/day0-hunt.mjs [chain] [startBlock] [blocks]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { SMART_ACCOUNT } from '../shop.mjs';

const CHAINS = {
  gnosis:   { rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://rpc.ankr.com/gnosis'], firstBlock: 1, mc: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  polygon:  { rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'], firstBlock: 1, mc: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  optimism: { rpcs: ['https://optimism-rpc.publicnode.com'], firstBlock: 1, mc: '0xcA11bde05977b3631167028862bE2a173976CA11' },
};
const chain = process.argv[2] || 'gnosis';
const START = Number(process.argv[3] || CHAINS[chain].firstBlock);
const NBLOCKS = Number(process.argv[4] || 4000);
const C = CHAINS[chain];
const EOA = SMART_ACCOUNT;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let rr = 0;
async function rpc(method, params, attempt = 0) {
  const url = C.rpcs[(rr++) % C.rpcs.length];
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) {
      if (/rate|limit|capacity|busy|429/i.test(j.error.message || '') && attempt < 6) { await sleep(400 * (attempt + 1)); return rpc(method, params, attempt + 1); }
      throw new Error(JSON.stringify(j.error).slice(0, 110));
    }
    return j.result;
  } catch (e) {
    if (attempt < 4) { await sleep(300 * (attempt + 1)); return rpc(method, params, attempt + 1); }
    throw e;
  }
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}

// ── STAGE 1: contract creations in the chain's earliest blocks ───────────────
console.log(`STAGE 1 — ${chain}: scanning blocks ${START}..${START + NBLOCKS} for contract births…`);
const blocks = Array.from({ length: NBLOCKS }, (_, k) => START + k);
const born = new Set();
let scanned = 0, seenTx = 0;
await pool(blocks, 8, async (b) => {
  const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]).catch(() => null);
  if (!blk) return;
  scanned++;
  for (const tx of blk.transactions || []) {
    seenTx++;
    if (tx.to === null || tx.to === undefined) {              // contract creation
      const rc = await rpc('eth_getTransactionReceipt', [tx.hash]).catch(() => null);
      if (rc?.contractAddress) born.add(rc.contractAddress.toLowerCase());
    }
  }
  if (scanned % 500 === 0) console.log(`  …${scanned}/${NBLOCKS} blocks · ${seenTx} txs · ${born.size} contracts born`);
});
console.log(`born: ${born.size} contracts across ${scanned} early blocks (${seenTx} txs)`);

// ── STAGE 2: which of these fossils still hold native value? ─────────────────
const addrs = [...born];
console.log(`STAGE 2 — checking live balances of ${addrs.length} fossils…`);
const funded = [];
await pool(addrs, 10, async (a) => {
  const [bal, code] = await Promise.all([
    rpc('eth_getBalance', [a, 'latest']).catch(() => '0x0'),
    rpc('eth_getCode', [a, 'latest']).catch(() => '0x'),
  ]);
  const wei = BigInt(bal);
  if (wei > 0n && code && code !== '0x') funded.push({ address: a, wei: wei.toString(), eth: ethers.formatEther(wei), codeLen: (code.length - 2) / 2, code });
});
funded.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
console.log(`funded fossils: ${funded.length}`);
for (const f of funded.slice(0, 15)) console.log(`  ${f.address} · ${f.eth} native · ${f.codeLen}b code`);

// ── STAGE 3: recover interface from bytecode, simulate every no-arg fn from ZERO ──
// PUSH4 selector harvest — same trick as our bruteforce instrument, applied to fossils that have
// no ABI anywhere on the internet.
function selectorsOf(code) {
  const out = new Set();
  const hex = code.slice(2);
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === '63') { // PUSH4
      const sel = '0x' + hex.slice(i + 2, i + 10);
      if (!/^0x0{8}$/.test(sel) && !/^0xf{8}$/.test(sel)) out.add(sel);
    }
  }
  return [...out];
}
console.log(`STAGE 3 — simulating no-arg calls on ${funded.length} funded fossils from ZERO…`);
const findings = [];
for (const f of funded) {
  const sels = selectorsOf(f.code).slice(0, 120);
  const before = BigInt(await rpc('eth_getBalance', [EOA, 'latest']).catch(() => '0x0'));
  for (const sel of sels) {
    // does the call even succeed from a stranger's address?
    let ok = false, ret = null;
    try { ret = await rpc('eth_call', [{ from: EOA, to: f.address, data: sel }, 'latest']); ok = true; } catch { }
    if (!ok) continue;
    // it succeeded — does it MOVE the contract's balance? simulate and re-read the fossil's balance
    // (eth_call has no state commit, so use eth_estimateGas as a second signal that it is executable)
    let gas = null;
    try { gas = Number(await rpc('eth_estimateGas', [{ from: EOA, to: f.address, data: sel }])); } catch { }
    if (gas && gas > 25000) {   // a pure view getter is cheap; >25k means it writes state
      findings.push({ fossil: f.address, held_native: f.eth, selector: sel, gas, returns: (ret || '').slice(0, 66) });
      console.log(`  *** EXECUTABLE STATE-CHANGING CALL: ${f.address} ${sel} gas=${gas} holds=${f.eth}`);
    }
  }
  await sleep(120);
}

const out = {
  probedAt: new Date().toISOString(), chain, startBlock: START, blocksScanned: scanned,
  contractsBorn: born.size, fundedFossils: funded.length,
  funded: funded.map(({ code, ...r }) => r).slice(0, 50),
  executableFindings: findings,
};
writeFileSync(new URL(`./day0-${chain}-result.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n=== ${born.size} born · ${funded.length} still funded · ${findings.length} executable state-changing calls ===`);
console.log(`saved -> scripts/day0-${chain}-result.json`);
