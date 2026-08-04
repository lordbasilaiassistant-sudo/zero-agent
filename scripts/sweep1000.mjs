// sweep1000.mjs — the scaled hunt. Read wide, then fire at everything that survives reading.
//   STAGE 1  scan thousands of blocks for value arriving AT THE SENDER (freemoney-map relation)
//   STAGE 2  READ FIRST: drop anything owner-gated / single-caller / trade-shaped
//   STAGE 3  FIRE: replay each survivor's FULL calldata from ZERO's address, measure balance delta
// Everything is eth_call — no money can move, nothing can be lost. Rate-limit aware: a throttled
// probe is recorded as UNTESTED, never as a negative (that trap already cost us once tonight).
//
// Usage: node scripts/sweep1000.mjs [blocks] [concurrency]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const NBLOCKS = Number(process.argv[2] || 2500);
const CONC = Number(process.argv[3] || 6);
const EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const RPCS = [
  'https://base-rpc.publicnode.com', 'https://mainnet.base.org',
  'https://base.drpc.org', 'https://1rpc.io/base', 'https://base.llamarpc.com',
];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRADE_SELECTORS = new Set(['0x38ed1739','0x7ff36ab5','0x18cbafe5','0x8803dbee','0x5c11d795','0x791ac947','0xb6f9de95','0x414bf389','0xc04b8d59','0xdb3e2198','0xf28c0498','0x04e45aaf','0x5023b4df','0xb858183f','0x3593564c','0xac9650d8','0x2e95b6c8','0x12aa3caf','0x0502b1c5','0xd0e30db0','0x2e1a7d4d','0xa9059cbb','0x23b872dd','0x095ea7b3']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let rr = 0;
async function rpc(method, params, attempt = 0) {
  const url = RPCS[(rr++) % RPCS.length];
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) {
      const rl = j.error.code === -32016 || /rate|limit|capacity|busy/i.test(j.error.message || '');
      if (rl && attempt < 6) { await sleep(400 * (attempt + 1)); return rpc(method, params, attempt + 1); }
      if (rl) throw new Error('RATE_LIMITED_UNTESTED');
      throw new Error(JSON.stringify(j.error).slice(0, 120));
    }
    return j.result;
  } catch (e) {
    if (String(e.message) === 'RATE_LIMITED_UNTESTED') throw e;
    if (attempt < 4) { await sleep(300 * (attempt + 1)); return rpc(method, params, attempt + 1); }
    throw e;
  }
}
const topicAddr = (t) => '0x' + (t || '').slice(26).toLowerCase();
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: String(e).slice(0, 90) }; } }
  }));
  return out;
}

// ── STAGE 1: scan ────────────────────────────────────────────────────────────
const latest = Number(await rpc('eth_blockNumber', []));
const blocks = Array.from({ length: NBLOCKS }, (_, k) => latest - k);
console.log(`STAGE 1 — scanning ${NBLOCKS} blocks on base from ${latest} (concurrency ${CONC})…`);

const payers = {};
let scanned = 0, txs = 0, hits = 0;
await pool(blocks, CONC, async (b) => {
  const hex = '0x' + b.toString(16);
  const [block, receipts] = await Promise.all([
    rpc('eth_getBlockByNumber', [hex, true]).catch(() => null),
    rpc('eth_getBlockReceipts', [hex]).catch(() => null),
  ]);
  if (!block || !receipts) return;
  scanned++;
  const byHash = Object.fromEntries((block.transactions || []).map(t => [t.hash, t]));
  for (const rc of receipts) {
    const tx = byHash[rc.transactionHash];
    if (!tx || !tx.to || rc.status !== '0x1') continue;
    txs++;
    const sender = tx.from.toLowerCase();
    const sel = (tx.input || '0x').slice(0, 10);
    if (sel.length < 10 || TRADE_SELECTORS.has(sel)) continue;
    if (tx.value && BigInt(tx.value) > 0n) continue;      // paid ETH => purchase, not a fee
    const inflow = {}, outflow = {};
    for (const log of rc.logs || []) {
      if ((log.topics?.[0] || '').toLowerCase() !== TRANSFER || log.topics.length < 3) continue;
      const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]), tok = log.address.toLowerCase();
      let amt = 0n; try { amt = BigInt(log.data.slice(0, 66)); } catch { }
      if (to === sender) inflow[tok] = (inflow[tok] ?? 0n) + amt;
      if (from === sender) outflow[tok] = (outflow[tok] ?? 0n) + amt;
    }
    if (Object.values(outflow).some(v => v > 0n)) continue; // gave value => exchange, not payout
    const net = Object.entries(inflow).filter(([, v]) => v > 0n);
    if (!net.length) continue;
    hits++;
    const key = `${tx.to.toLowerCase()}:${sel}`;
    const p = payers[key] ||= { contract: tx.to.toLowerCase(), selector: sel, hits: 0, callers: new Set(), tokens: {}, sampleTx: rc.transactionHash, gas: 0 };
    p.hits++; p.callers.add(sender); p.gas = Number(rc.gasUsed);
    for (const [t, v] of net) p.tokens[t] = (p.tokens[t] ?? 0n) + v;
  }
  if (scanned % 250 === 0) console.log(`  …${scanned}/${NBLOCKS} blocks · ${txs} txs · ${hits} payout-shaped · ${Object.keys(payers).length} payers`);
});
console.log(`scan done: ${scanned} blocks · ${txs} txs · ${Object.keys(payers).length} distinct (contract,selector) payers`);

// ── STAGE 2: READ FIRST ──────────────────────────────────────────────────────
// Permissionless-looking == paid MANY DISTINCT callers. One repeat caller is an operator.
const survivors = Object.values(payers)
  .map(p => ({ ...p, distinct: p.callers.size, tokens: Object.fromEntries(Object.entries(p.tokens).map(([k, v]) => [k, v.toString()])) }))
  .filter(p => p.distinct >= 2)
  .sort((a, b) => b.distinct - a.distinct);
console.log(`STAGE 2 — ${survivors.length} candidates paid 2+ distinct callers (from ${Object.keys(payers).length})`);

// ── STAGE 3: FIRE ────────────────────────────────────────────────────────────
const mc = new ethers.Interface(['function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)']);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const bare = (a) => a.toLowerCase().replace(/^0x/, '');
console.log(`STAGE 3 — replaying ${survivors.length} with full calldata from ZERO…`);

let done = 0;
const fired = await pool(survivors, 4, async (c) => {
  const row = { contract: c.contract, selector: c.selector, distinct_callers: c.distinct, hits: c.hits, sample_tx: c.sampleTx, gas: c.gas };
  try {
    const tx = await rpc('eth_getTransactionByHash', [c.sampleTx]);
    if (!tx) { row.error = 'no sample tx'; return row; }
    let data = tx.input;
    const orig = bare(tx.from);
    row.subs = (data.toLowerCase().match(new RegExp(orig, 'g')) || []).length;
    if (row.subs) data = data.replace(new RegExp(orig, 'gi'), bare(EOA));
    const toks = Object.keys(c.tokens);
    const calls = [
      ...toks.map(t => ({ target: t, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [EOA]) })),
      { target: c.contract, allowFailure: true, callData: data },
      ...toks.map(t => ({ target: t, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [EOA]) })),
    ];
    const res = await rpc('eth_call', [{ from: EOA, to: MULTICALL, data: mc.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
    const [dec] = mc.decodeFunctionResult('aggregate3', res);
    const n = toks.length;
    row.ok = dec[n].success;
    row.deltas = {};
    for (let i = 0; i < n; i++) {
      if (!dec[i].success || !dec[i + n + 1].success) continue;
      const d = BigInt(dec[i + n + 1].returnData) - BigInt(dec[i].returnData);
      if (d !== 0n) row.deltas[toks[i]] = d.toString();
      if (d > 0n) row.PAYS = true;
    }
  } catch (e) {
    row.error = String(e).slice(0, 120);
    row.untested = row.error.includes('RATE_LIMITED_UNTESTED');
  }
  if (++done % 25 === 0) console.log(`  …fired ${done}/${survivors.length}`);
  if (row.PAYS) console.log(`  *** PAYS ZERO: ${row.contract} ${row.selector} deltas=${JSON.stringify(row.deltas)}`);
  return row;
});

const winners = fired.filter(r => r?.PAYS);
const untested = fired.filter(r => r?.untested);
const out = {
  probedAt: new Date().toISOString(), blocksScanned: scanned, txsExamined: txs,
  distinctPayers: Object.keys(payers).length, multiCallerCandidates: survivors.length,
  fired: fired.length, winners: winners.length, untested: untested.length,
  WINNERS: winners, sample: fired.filter(r => r && !r.PAYS).slice(0, 40),
};
writeFileSync(new URL('./sweep1000-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n=== ${Object.keys(payers).length} payers found · ${survivors.length} multi-caller · ${fired.length} fired · ${winners.length} PAY ZERO · ${untested.length} untested ===`);
if (winners.length) console.log(JSON.stringify(winners, null, 2));
console.log('saved -> scripts/sweep1000-result.json');
