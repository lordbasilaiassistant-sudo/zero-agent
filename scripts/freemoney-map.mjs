// freemoney-map.mjs — READ THE CHAIN LIKE A HOW-TO GUIDE.
//
// Every instrument we had priced contracts we already knew about (payout_oracle) or recovered an
// interface we already had an address for (bruteforce). Both answer "does THIS pay?".
// This answers the question nobody asked: **WHO IS ALREADY BEING PAID, RIGHT NOW, BY ANYONE?**
//
// Method (the relation, not the product): scan recent blocks; for every transaction, look for value
// arriving AT THE SENDER inside their own transaction. If a random address called a function and
// tokens came back to them in the same tx, that contract pays callers — regardless of whether any
// doc, guide, or catalogue has ever mentioned it. Then subtract everything that is merely a trade.
//
// This produces an EMPIRICAL map of caller-paying mechanisms, including classes we have never
// enumerated, ranked by what they actually paid. Free: pure RPC reads.
//
// Usage: node scripts/freemoney-map.mjs [blocks] [chain]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const CHAINS = {
  base: { rpc: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], explorer: 'https://base.blockscout.com/api/v2' },
  optimism: { rpc: ['https://optimism-rpc.publicnode.com'], explorer: 'https://optimism.blockscout.com/api/v2' },
  arbitrum: { rpc: ['https://arbitrum-one-rpc.publicnode.com'], explorer: null },
};
const chainName = process.argv[3] || 'base';
const CHAIN = CHAINS[chainName];
const NBLOCKS = Number(process.argv[2] || 300);

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH_DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'; // Deposit(address,uint256)

// Anything whose PURPOSE is to give you tokens back is not a payout — it's a trade. Exclude by role.
const TRADE_SELECTORS = new Set([
  '0x38ed1739', '0x7ff36ab5', '0x18cbafe5', '0x8803dbee', '0x5c11d795', '0x791ac947', '0xb6f9de95', // univ2
  '0x414bf389', '0xc04b8d59', '0xdb3e2198', '0xf28c0498', '0x04e45aaf', '0x5023b4df', '0xb858183f', // univ3
  '0x3593564c', // universal router
  '0xac9650d8', // multicall (router)
  '0x2e95b6c8', '0x12aa3caf', '0x0502b1c5', // 1inch
  '0xd0e30db0', // deposit (wrap)
  '0x2e1a7d4d', // withdraw (unwrap)
  '0xa9059cbb', '0x23b872dd', // transfer / transferFrom
  '0x095ea7b3', // approve
]);

async function rpc(method, params) {
  let lastErr;
  for (const url of CHAIN.rpc) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 140));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const topicAddr = (t) => '0x' + (t || '').slice(26).toLowerCase();

const latest = Number(await rpc('eth_blockNumber', []));
console.log(`scanning ${NBLOCKS} blocks on ${chainName} back from ${latest}…`);

const payers = {};       // key: `${contract}:${selector}` -> stats
let scanned = 0, txs = 0, candidates = 0;

for (let b = latest; b > latest - NBLOCKS; b--) {
  let block, receipts;
  try {
    block = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]);
    receipts = await rpc('eth_getBlockReceipts', ['0x' + b.toString(16)]);
  } catch { continue; }
  if (!block || !receipts) continue;
  scanned++;
  const byHash = Object.fromEntries((block.transactions || []).map(t => [t.hash, t]));

  for (const rc of receipts) {
    const tx = byHash[rc.transactionHash];
    if (!tx || !tx.to || rc.status !== '0x1') continue;
    txs++;
    const sender = tx.from.toLowerCase();
    const selector = (tx.input || '0x').slice(0, 10);
    if (selector.length < 10) continue;                 // plain ETH send
    if (TRADE_SELECTORS.has(selector)) continue;        // a trade is not a payout
    // CRITICAL: if the caller SENT ETH with the call, tokens coming back are a PURCHASE, not a fee.
    // Without this, every DEX buy paid in native ETH looks like a payout (1inch showed up as a
    // "$12/call payer" on the first run purely from this hole).
    if (tx.value && BigInt(tx.value) > 0n) continue;

    // value arriving AT THE SENDER inside their own transaction
    const inflow = {}, outflow = {};
    for (const log of rc.logs || []) {
      const t0 = (log.topics?.[0] || '').toLowerCase();
      if (t0 === TRANSFER && log.topics.length >= 3) {
        const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]);
        const token = log.address.toLowerCase();
        let amt = 0n; try { amt = BigInt(log.data.slice(0, 66)); } catch { }
        if (to === sender) inflow[token] = (inflow[token] ?? 0n) + amt;
        if (from === sender) outflow[token] = (outflow[token] ?? 0n) + amt;
      } else if (t0 === WETH_DEPOSIT && topicAddr(log.topics?.[1]) === sender) {
        // wrapping own ETH is not income
        const token = log.address.toLowerCase();
        let amt = 0n; try { amt = BigInt(log.data.slice(0, 66)); } catch { }
        outflow[token] = (outflow[token] ?? 0n) + amt;
      }
    }
    // NET inflow only: if they sent the same token out, it's a swap/repay leg, not a fee
    const net = {};
    for (const [tok, amt] of Object.entries(inflow)) {
      const n = amt - (outflow[tok] ?? 0n);
      if (n > 0n) net[tok] = n;
    }
    if (!Object.keys(net).length) continue;
    // If the sender paid ANY token out, this is an exchange of value, not a one-sided payout.
    if (Object.values(outflow).some(v => v > 0n)) continue;
    candidates++;

    const key = `${tx.to.toLowerCase()}:${selector}`;
    const p = payers[key] ||= {
      contract: tx.to.toLowerCase(), selector, hits: 0, distinctCallers: new Set(),
      tokens: {}, sampleTx: rc.transactionHash, gasUsed: [],
    };
    p.hits += 1;
    p.distinctCallers.add(sender);
    p.gasUsed.push(Number(rc.gasUsed));
    for (const [tok, amt] of Object.entries(net)) p.tokens[tok] = (p.tokens[tok] ?? 0n) + amt;
  }
  if (scanned % 50 === 0) console.log(`  …${scanned} blocks, ${txs} txs, ${candidates} payout-shaped`);
}

console.log(`\nscanned ${scanned} blocks · ${txs} txs · ${candidates} payout-shaped events · ${Object.keys(payers).length} distinct (contract,selector) payers`);

// price the tokens we actually saw
const priceCache = {};
async function usd(token) {
  if (token in priceCache) return priceCache[token];
  let p = 0, dec = 18;
  if (CHAIN.explorer) {
    try {
      const t = await fetch(`${CHAIN.explorer}/tokens/${token}`).then(r => r.json());
      p = parseFloat(t.exchange_rate) || 0; dec = Number(t.decimals) || 18;
    } catch { }
  }
  priceCache[token] = { p, dec };
  return priceCache[token];
}

const rows = [];
for (const p of Object.values(payers)) {
  let totalUsd = 0; const toks = [];
  for (const [tok, amt] of Object.entries(p.tokens)) {
    const { p: px, dec } = await usd(tok);
    const v = Number(ethers.formatUnits(amt, dec)) * px;
    totalUsd += v;
    toks.push({ token: tok, raw: amt.toString(), usd: +v.toFixed(6) });
  }
  rows.push({
    contract: p.contract, selector: p.selector, hits: p.hits,
    distinct_callers: p.distinctCallers.size,
    total_usd: +totalUsd.toFixed(6),
    usd_per_call: +(totalUsd / p.hits).toFixed(6),
    avg_gas: Math.round(p.gasUsed.reduce((a, b) => a + b, 0) / p.gasUsed.length),
    tokens: toks, sample_tx: p.sampleTx,
  });
}
rows.sort((a, b) => b.usd_per_call - a.usd_per_call);

// The prize: payers with MANY DISTINCT CALLERS are open to anyone (permissionless);
// a single repeat caller is usually a privileged operator claiming their own revenue.
const open = rows.filter(r => r.distinct_callers >= 2 && r.usd_per_call > 0);
const rich = rows.filter(r => r.usd_per_call >= 0.01);

console.log('\n=== TOP PAYERS BY USD PER CALL ===');
for (const r of rows.slice(0, 20)) {
  console.log(` $${r.usd_per_call.toFixed(5)}/call · ${r.hits} hits · ${r.distinct_callers} callers · ${r.contract} ${r.selector} · gas ${r.avg_gas}`);
}
console.log('\n=== PERMISSIONLESS-LOOKING (2+ distinct callers, nonzero pay) ===');
for (const r of open.slice(0, 20)) {
  console.log(` $${r.usd_per_call.toFixed(5)}/call · ${r.distinct_callers} callers · ${r.contract} ${r.selector}`);
}

const out = {
  probedAt: new Date().toISOString(), chain: chainName, blocksScanned: scanned, fromBlock: latest,
  txsExamined: txs, payoutShapedEvents: candidates,
  distinctPayers: rows.length, openPayers: open.length, richPayers: rich.length,
  top: rows.slice(0, 60), permissionless: open.slice(0, 60),
};
writeFileSync(new URL('./freemoney-map-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/freemoney-map-result.json');
