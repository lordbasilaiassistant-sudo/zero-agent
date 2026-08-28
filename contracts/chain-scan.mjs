// chain-scan.mjs — point ZERO's bytecode reader at the CHAIN instead of at one protocol's API.
//
// THE CEILING, AND WHY IT IS NOT REAL. ZERO's entire candidate universe comes from
// `https://api.beefy.finance/vaults` (harvest.mjs:146): 241 contracts. Base has 977,007,834 addresses
// and does 7.5M transactions a day. ZERO has been fishing in 0.000025% of the water, and every
// "ceiling" measured inside that slice was a property of the slice, not of the chain.
//
// ZERO already owns the instrument to fix this. `bruteforce.mjs` recovers a contract's complete
// external interface straight from runtime bytecode by reading the PUSH4 dispatch table — no ABI, no
// source, no explorer, no permission. It works on unverified contracts, on contracts nobody has ever
// called, and on contracts deployed an hour ago by someone who does not know what they deployed. That
// instrument has never been pointed at the chain at scale. This points it.
//
// THE FUNNEL, ordered so the expensive step runs last:
//   1. VALUE FIRST. A contract with no balance cannot pay anyone. Pull recent WETH Transfer logs and
//      keep the RECIPIENTS that are contracts — that is a live, self-refreshing list of contracts
//      holding the exact asset we want, discovered from the chain's own event stream.
//   2. INTERFACE. Recover every external selector from bytecode (metadata stripped, instruction
//      boundaries preferred — 14% of naive PUSH4 hits are phantoms sitting inside PUSH immediates).
//   3. PAYMENT. For each money-shaped selector, run an ISOLATED probe and keep only strictly positive
//      deltas.
//
// ⚠️ ONE aggregate3 PER PROBE. Sharing state across a batch produced 94.7% false positives (214 of
// 226) in tonight's measurement and is the reason ZERO has been spending relay slots on strategies
// that pay zero. Batching is for READS. Never for payment tests.
//
// Read-only: eth_call and eth_getLogs only. No gas, no signature, no slot, no key, no state change.
import { ethers } from 'ethers';
import fs from 'node:fs';
import { RpcPool } from './rpcpool.mjs';

import { SMART_ACCOUNT } from '../shop.mjs';

const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH = '0x4200000000000000000000000000000000000006';
const ZERO_SAFE = SMART_ACCOUNT;
const BLOCKS = Number(process.env.BLOCKS || 600);     // ~20 min of Base
const MAX_CONTRACTS = Number(process.env.MAX_CONTRACTS || 60);
const MIN_HOLD_WEI = BigInt(process.env.MIN_HOLD_WEI || '100000000000000'); // 1e14 = ~$0.0002
const MAX_SELECTORS = Number(process.env.MAX_SELECTORS || 40); // per contract, highest-confidence first

// Rotate across every healthy public endpoint and cache immutable reads. Measured: 6 usable Base
// endpoints, and 60 getCode calls collapse to 4 network requests. Rate limits stopped being the
// binding constraint on how much chain we can look at.
const pool = new RpcPool('base');
const p = {
  call: (tx) => pool.send('eth_call', [tx, 'latest']),
  getCode: (a) => pool.send('eth_getCode', [a, 'latest']),
  getBlockNumber: async () => parseInt(await pool.send('eth_blockNumber', []), 16),
  send: (m, ps) => pool.send(m, ps),
};
const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
const balOf = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agg = async (calls) =>
  AGG.decodeFunctionResult('aggregate3', await p.call({ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }))[0];

// ── selector recovery: metadata-stripped, instruction-boundary aware ────────────────────────────────
const SKIP = new Set([
  '0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0x70a08231', '0xdd62ed3e', '0x01ffc9a7',
  '0x8da5cb5b', '0x5c60da1b', '0x3644e515', '0x54fd4d50', '0xc45a0155', '0x0dfe1681', '0xd21220a7',
  '0x38d52e0f', '0x7dc0d1d0', '0xfc0c546a', '0x17d7de7c', '0xa9059cbb', '0x23b872dd', '0x095ea7b3',
  '0x40c10f19', '0x42966c68',
]);
function stripMeta(b) {
  if (b.length < 3) return b;
  const len = (b[b.length - 2] << 8) | b[b.length - 1];
  const end = b.length - 2 - len;
  return end > 0 && end < b.length && (b[end] === 0xa2 || b[end] === 0xa3) ? b.subarray(0, end) : b;
}
function selectorsRanked(code) {
  const bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
  const codeOnly = stripMeta(bytes);
  const bounds = new Set();
  for (let i = 0; i < codeOnly.length; ) {
    bounds.add(i);
    const op = codeOnly[i];
    i += op >= 0x60 && op <= 0x7f ? op - 0x5f + 1 : 1;
  }
  const seen = new Map();
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] !== 0x63) continue;
    const s = '0x' + bytes.subarray(i + 1, i + 5).toString('hex');
    if (/^0x0{4,}/.test(s) || SKIP.has(s)) continue;
    const c = bounds.has(i) && i < codeOnly.length ? 2 : 0;
    if (!seen.has(s) || seen.get(s) < c) seen.set(s, c);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

// Zero-argument money-shaped calls we can try blind. The dispatch table tells us which EXIST; this
// tells us which are worth spending a probe on. Anything unrecognised is still probed — the unnamed
// ones are the interesting ones.
const NAMED = {};
for (const sig of [
  'harvest()', 'claim()', 'claimRewards()', 'claimReward()', 'getReward()', 'collect()', 'collectFees()',
  'skim()', 'sweep()', 'poke()', 'update()', 'sync()', 'checkpoint()', 'kick()', 'ping()', 'drip()',
  'faucet()', 'mint()', 'freeMint()', 'withdraw()', 'redeem()', 'compound()', 'tend()', 'work()',
  'distribute()', 'distributeFees()', 'release()', 'settle()', 'accrue()', 'rebalance()', 'gulp()',
]) NAMED[ethers.id(sig).slice(0, 10)] = sig;

// ── 1. VALUE FIRST — and, crucially, OLD value ─────────────────────────────────────────────────────
//
// FIRST ATTEMPT, AND WHY IT FOUND NOTHING. The initial version scanned the most RECENT blocks: 299
// selectors across 30 contracts holding WETH, zero payers. The population was the problem, not the
// method. A contract that received WETH in the last five minutes is a DEX pool, a router, an
// aggregator — live infrastructure whose balance is working liquidity, tended continuously by people
// who want it. There is no forgotten money in a contract somebody is using right now.
//
// Anthony named the right ground: "looking for old untouched things." Value that has sat unclaimed for
// months is, by definition, value nobody is competing for — which is the only kind ZERO can win, since
// it holds 5 relay slots a day and cannot outrun anyone. So BLOCK_OFFSET walks the window backwards in
// time: find contracts the chain handed WETH to long ago, and ask which of them STILL hold it.
// Still holding after months is the signal. It means no owner swept it and no bot found it.
const head = await p.getBlockNumber();
const OFFSET = Number(process.env.BLOCK_OFFSET || 0);   // blocks BACK from head (Base ~43,200/day)
const to = head - OFFSET;
const from = to - BLOCKS;
const ageDays = (OFFSET / 43200).toFixed(1);
console.log(`scanning Base blocks ${from}..${to}` + (OFFSET ? `  (${ageDays} days ago — archaeology mode)` : '  (live head)') + `\n`);

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
let logs = [];
// 50-block windows: the strictest public endpoint caps eth_getLogs at 50, and a window that is
// rejected returns NOTHING rather than less — which would silently shrink the candidate set.
for (let b = from; b < to; b += 50) {
  try {
    logs.push(...(await p.send('eth_getLogs', [{
      address: WETH, topics: [TRANSFER], fromBlock: '0x' + b.toString(16),
      toBlock: '0x' + Math.min(b + 49, to).toString(16),
    }])));
  } catch (e) { console.log('  getLogs window failed:', String(e.message).slice(0, 80)); }
}
const recipients = [...new Set(logs.map((l) => '0x' + l.topics[2].slice(26).toLowerCase()))].filter((a) => a !== ethers.ZeroAddress);
console.log(`WETH transfers: ${logs.length} · distinct recipients: ${recipients.length}`);

// Which are contracts, and which hold enough to be worth probing.
// Public RPCs rate-limit hard; balances go through Multicall3 in modest chunks, and getCode is only
// spent on addresses that already passed the balance filter — never on the whole recipient list.
const contracts = [];
for (let i = 0; i < recipients.length; i += 50) {
  const slice = recipients.slice(i, i + 50);
  let bals;
  try {
    bals = await agg(slice.map((a) => ({ target: WETH, allowFailure: true, callData: balOf(a) })));
  } catch (e) {
    console.log(`  balance chunk ${i} failed (${String(e.message).slice(0, 60)}) — backing off`);
    await sleep(1500);
    continue;
  }
  const rich = [];
  bals.forEach((b, k) => {
    try { if (BigInt(b.returnData) >= MIN_HOLD_WEI) rich.push({ addr: slice[k], bal: BigInt(b.returnData) }); } catch {}
  });
  // getCode is one request each, so serialise with a small gap rather than firing 50 at once
  for (const r of rich) {
    const code = await p.getCode(r.addr).catch(() => '0x');
    if (code.length > 2) contracts.push({ ...r, code });
  }
}
contracts.sort((a, b) => (b.bal > a.bal ? 1 : -1));
const targets = contracts.slice(0, MAX_CONTRACTS);
console.log(`contracts holding >= ${MIN_HOLD_WEI} wei WETH: ${contracts.length} · probing top ${targets.length}\n`);

// ── 2+3. INTERFACE, then ISOLATED PAYMENT PROBE ────────────────────────────────────────────────────
const hits = [];
let probed = 0;
for (const t of targets) {
  // Probe EVERY recovered selector, not only the ones I could name. Filtering to a hand-written list
  // reproduces exactly the blindness this scanner exists to end — the whole value of reading the
  // dispatch table is that it surfaces functions nobody has heard of, and those are where an
  // unclaimed mechanism would hide. A selector needing arguments simply reverts on an empty call,
  // which costs nothing and is itself information.
  const sels = selectorsRanked(t.code).slice(0, MAX_SELECTORS);
  if (!sels.length) continue;
  for (const sel of sels) {
    probed++;
    try {
      // MEASURE THE CALLER, NOT ZERO. A zero-argument money function pays `msg.sender`, and inside an
      // aggregate3 that is MULTICALL3 — never ZERO's Safe. The first version of this scanner measured
      // ZERO_SAFE's balance and was therefore structurally incapable of seeing a payment, which is
      // almost certainly why it reported 0 payers across 663 probed selectors. oracle.mjs got this
      // right (it measures MULTICALL3); I did not, and then read my own blindness as a result about
      // the chain. Whatever Multicall3 receives here, ZERO receives when it makes the same call.
      const r = await agg([
        { target: WETH, allowFailure: true, callData: balOf(MULTICALL3) },
        { target: t.addr, allowFailure: true, callData: sel },
        { target: WETH, allowFailure: true, callData: balOf(MULTICALL3) },
      ]);
      if (!r[0]?.success || !r[2]?.success) continue;
      const d = BigInt(r[2].returnData) - BigInt(r[0].returnData);
      if (d > 0n) {
        hits.push({ contract: t.addr, selector: sel, sig: NAMED[sel] || "UNKNOWN "+sel, wei: d.toString(), holds: t.bal.toString(), callSucceeded: !!r[1]?.success });
        console.log(`  💰 ${t.addr}  ${(NAMED[sel]||sel).padEnd(18)} pays ${d} wei  (holds ${ethers.formatEther(t.bal)} WETH)`);
      }
    } catch { /* a probe that fails is information too, just not actionable */ }
    // pacing handled by the pool (rotation + quarantine), no artificial delay needed
  }
}

const eth = 1861.94;
const total = hits.reduce((a, h) => a + BigInt(h.wei), 0n);
console.log(`\n=== CHAIN-FIRST SCAN ===`);
console.log(`blocks scanned      : ${BLOCKS}`);
console.log(`contracts examined  : ${targets.length}   (from the chain, NOT from any API)`);
console.log(`selectors probed    : ${probed}`);
console.log(`PAYING contracts    : ${hits.length}`);
console.log(`total measured      : ${total} wei = $${(Number(total) * 1e-18 * eth).toFixed(6)}`);
if (hits.length) {
  console.log(`\ntop payers:`);
  for (const h of hits.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1)).slice(0, 10)) {
    console.log(`  ${(Number(h.wei) * 1e-18 * eth).toFixed(6).padStart(10)}  ${h.contract}  ${h.sig}`);
  }
}

fs.writeFileSync(
  new URL('./chain-scan-results.json', import.meta.url),
  JSON.stringify({
    measuredAt: new Date().toISOString(), head, blocksScanned: BLOCKS,
    recipientsSeen: recipients.length, contractsHoldingWeth: contracts.length,
    contractsProbed: targets.length, selectorsProbed: probed,
    payingContracts: hits.length, totalWei: total.toString(),
    totalUsd: Number((Number(total) * 1e-18 * eth).toFixed(6)),
    note: 'Each payment measured in its OWN aggregate3 — never batched, because shared state produced 94.7% false positives.',
    hits: hits.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1)),
  }, null, 2) + '\n',
);
console.log('\n→ contracts/chain-scan-results.json');
