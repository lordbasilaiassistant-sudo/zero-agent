// MINE THE KEEPER ECONOMY FROM THE CHAIN ITSELF.
//
// No protocol list, no docs, no recollection. For every recent block: pull the full block (tx inputs)
// and all its receipts. A keeper bounty leaves an unmistakable fingerprint —
//     tx.from == the `to` of an ERC20 Transfer emitted inside its own transaction
// i.e. the account that sent the tx ended it holding MORE of some token. That is, by definition, a
// contract paying an arbitrary caller. It finds every protocol that does this, including ones nobody
// has written a docs page for, and it hands us the exact selector that did the paying.
//
// Output is a LEAD list (historical settlement). Every lead is then re-measured with an ISOLATED
// aggregate3 payment test before it counts.
import { rpc, pin, pinnedDec } from './_kb_lib.mjs';
import fs from 'fs';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAIN = process.argv[2] || 'base';
const NBLOCKS = Number(process.argv[3] || 60);

const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const low = (a) => (a || '').toLowerCase();

await pin(CHAIN);
const head = Number(BigInt(await rpc(CHAIN, 'eth_blockNumber', [])));
console.log(`mining ${CHAIN} blocks ${head - NBLOCKS + 1}..${head}`);

const hits = [];
let scannedTx = 0, scannedBlocks = 0;
for (let b = head - NBLOCKS + 1; b <= head; b++) {
  const hex = '0x' + b.toString(16);
  let blk, rcpts;
  try {
    [blk, rcpts] = await Promise.all([
      rpc(CHAIN, 'eth_getBlockByNumber', [hex, true]),
      rpc(CHAIN, 'eth_getBlockReceipts', [hex]),
    ]);
  } catch (e) { continue; }
  if (!blk?.transactions || !rcpts) continue;
  scannedBlocks++;
  const byHash = {};
  for (const t of blk.transactions) byHash[low(t.hash)] = t;
  for (const r of rcpts) {
    scannedTx++;
    if (r.status !== '0x1') continue;
    const tx = byHash[low(r.transactionHash)];
    if (!tx || !tx.to) continue;
    const me = pad(r.from);
    // THE FILTER THAT SEPARATES A BOUNTY FROM A SWAP. In a swap/deposit/repay the sender also PAYS
    // something — native value, or a token Transfer with `from` == sender. A keeper bounty is the
    // shape where value flows ONE WAY: the sender put in nothing but gas and came out richer.
    if (tx.value && BigInt(tx.value) > 0n) continue;
    let sentSomething = false;
    for (const lg of r.logs || []) {
      if (low(lg.topics?.[0]) !== TRANSFER || lg.topics.length < 3) continue;
      if (low(lg.topics[1]) === me) { sentSomething = true; break; }
    }
    if (sentSomething) continue;
    for (const lg of r.logs || []) {
      if (low(lg.topics?.[0]) !== TRANSFER) continue;
      if (lg.topics.length < 3) continue;
      if (low(lg.topics[2]) !== me) continue;          // credited the tx sender
      if (low(lg.topics[1]) === me) continue;          // self-transfer
      let amt = 0n; try { amt = BigInt(lg.data); } catch { continue; }
      if (amt === 0n) continue;
      hits.push({
        chain: CHAIN, block: b, tx: r.transactionHash,
        target: tx.to, selector: (tx.input || '0x').slice(0, 10),
        input: (tx.input || '0x').slice(0, 138),
        keeper: r.from, token: lg.address, amount: amt.toString(),
        from: '0x' + low(lg.topics[1]).slice(26),
        gasUsed: Number(BigInt(r.gasUsed)),
      });
    }
  }
  if ((b - head + NBLOCKS) % 20 === 0) process.stdout.write('.');
}
console.log(`\nscanned ${scannedBlocks} blocks / ${scannedTx} txs -> ${hits.length} sender-credited transfers`);

// Group by (target, selector): a repeated pair is a live, recurring keeper bounty.
const g = {};
for (const h of hits) {
  const k = `${h.target}|${h.selector}`;
  (g[k] ||= { chain: CHAIN, target: h.target, selector: h.selector, n: 0, keepers: new Set(), tokens: new Set(), amounts: [], gas: [], sample: h.tx, input: h.input });
  g[k].n++; g[k].keepers.add(low(h.keeper)); g[k].tokens.add(low(h.token));
  g[k].amounts.push(h.amount); g[k].gas.push(h.gasUsed);
}
const rows = Object.values(g).map(x => ({
  chain: x.chain, target: x.target, selector: x.selector, occurrences: x.n,
  distinctKeepers: x.keepers.size, tokens: [...x.tokens], sample: x.sample, input: x.input,
  maxAmount: x.amounts.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), '0'),
  medGas: x.gas.sort((a, b) => a - b)[Math.floor(x.gas.length / 2)],
})).sort((a, b) => b.occurrences - a.occurrences);

console.log(`\n${rows.length} distinct (contract, selector) pairs that paid their caller:\n`);
for (const r of rows.slice(0, 60)) {
  console.log(`  ${r.target} ${r.selector} x${String(r.occurrences).padStart(3)} keepers=${r.distinctKeepers} max=${r.maxAmount} gas=${r.medGas} tok=${r.tokens.slice(0, 2).join(',')}`);
}
fs.writeFileSync(`knowledge/streams/_kb_mine_${CHAIN}.json`, JSON.stringify({ chain: CHAIN, head, nblocks: scannedBlocks, rows }, null, 2));
