#!/usr/bin/env node
/**
 * attic-scan.mjs — FIND WHAT THE BOTS DO NOT LOOK FOR.
 *
 * Anthony, 2026-08-21: *"beat the bots and the rest by finding what they cant find."*
 *
 * Searchers and liquidation bots are fast, well-capitalised, and pointed at INDEXED flow: mempool
 * transactions, known protocols, positions a subgraph already tracks. Racing them there is a speed
 * game we lose on every axis.
 *
 * What they do not do is read the bytecode of contracts nobody has catalogued. It is a haystack
 * search with no guaranteed payoff — irrational for an operation chasing known-profitable flow, and
 * cheap for us, because reading is free and we are not paying anyone's salary to wait.
 *
 * THE RELATION (never the product): **a contract that holds value and exposes a function that
 * releases it to whoever calls, with nothing gating the caller.** Abandoned fee splitters, orphaned
 * payment contracts, forgotten escrows, deployments whose owner walked away. The money is already
 * sitting there; nobody is competing for it because nobody has enumerated it.
 *
 * METHOD, in the order that makes it cheap:
 *   1. Collect contract addresses that appear as a call target in recent blocks.
 *   2. Batch `eth_getBalance` — discard everything holding nothing. This kills 95%+ for one call each.
 *   3. `eth_getCode` on the survivors and scan the dispatcher for value-releasing selectors
 *      (withdraw/sweep/rescue/claim/collect/release/flush/drain...). solc emits every external
 *      selector as a PUSH4 literal, so this works on unverified contracts with no ABI and no explorer.
 *   4. Flag the GATES in the same pass (owner/onlyOwner/auth/paused). A release function next to an
 *      owner check is somebody's treasury, not an attic.
 *   5. Simulate the survivors FROM ZERO'S OWN ADDRESS with eth_simulateV1 + traceTransfers, and keep
 *      only what actually moves value TO ZERO.
 *
 * ⚠️ THE LINE THIS TOOL DOES NOT CROSS. It looks for value that a contract will hand to ANY caller by
 * its own published rules — an open door, not a lock to pick. It does not search for exploits, reentrancy,
 * broken access control, or any path that depends on a contract behaving other than as written. If a
 * function requires an owner and we would have to defeat that check, it is not a candidate; it is
 * somebody's property. The test is simple and it is applied in code below: would this call succeed for
 * anyone who tried it, exactly as the contract is written?
 *
 * Usage:
 *   node scripts/attic-scan.mjs --chain gnosis --blocks 400
 *   node scripts/attic-scan.mjs --chain base --blocks 200 --min-usd 0.05
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'ethers';
import { SMART_ACCOUNT } from '../shop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZERO = SMART_ACCOUNT;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const CH = {
  gnosis:   { rpc: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], px: 'coingecko:xdai' },
  base:     { rpc: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'], px: 'coingecko:ethereum' },
  optimism: { rpc: ['https://optimism-rpc.publicnode.com'], px: 'coingecko:ethereum' },
  arbitrum: { rpc: ['https://arbitrum-one-rpc.publicnode.com'], px: 'coingecko:ethereum' },
};

/* Functions that hand value to the caller. Zero-argument forms first: they need no knowledge of the
 * contract's internals, so if one of these is open, anyone could always have taken it. */
const RELEASE = {
  '3ccfd60b': 'withdraw()', '853828b6': 'withdrawAll()', '35faa416': 'sweep()',
  '4e71d92d': 'claim()', 'e5225381': 'collect()', '86d1a69f': 'release()',
  'e086e5ec': 'withdrawETH()', 'db2e21bc': 'emergencyWithdraw()', '6b9f96ea': 'flush()',
  '2e64cec1': 'retrieve()', 'ce746024': 'recover()', '0614117a': 'recoverETH()',
  '9890220b': 'drain()', '63bd1d4a': 'payout()', 'd0e30db0x': 'n/a',
};
/* If any of these are present the contract almost certainly gates its release on an owner or role.
 * Presence is not proof, so it downgrades a candidate rather than dropping it — the simulation from
 * ZERO's address is the actual verdict. */
const GATES = ['8da5cb5b', 'f2fde38b', '715018a6', '91d14854', '2f2ff15d', 'a217fddf', '5c975abb'];

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const chain = opt('chain', 'gnosis');
const NBLOCKS = Number(opt('blocks', 300));
const MIN_USD = Number(opt('min-usd', 0.02));
const cfg = CH[chain];
if (!cfg) { console.error('unknown chain'); process.exit(2); }

let RPC = cfg.rpc[0];
const call = async (method, params, tries = 2) => {
  for (let i = 0; i < tries; i++) {
    for (const u of cfg.rpc) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
        const j = await r.json();
        if (!j.error) { RPC = u; return j.result; }
      } catch { /* next */ }
    }
  }
  return null;
};
const batch = async (calls, size = 40) => {
  const out = new Array(calls.length).fill(null);
  for (let s = 0; s < calls.length; s += size) {
    const body = calls.slice(s, s + size).map((c, i) => ({ jsonrpc: '2.0', id: s + i, method: c.method, params: c.params }));
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
      const j = await r.json();
      if (Array.isArray(j)) for (const x of j) if (x && typeof x.id === 'number' && !x.error) out[x.id] = x.result;
    } catch { /* leave nulls; reported */ }
  }
  return out;
};

const px = await (await fetch('https://coins.llama.fi/prices/current/' + cfg.px)).json()
  .then(j => j.coins[cfg.px]?.price ?? null).catch(() => null);
console.log(`attic-scan · ${chain} · native $${px}`);

const head = Number(await call('eth_blockNumber', []));
console.log(`scanning ${NBLOCKS} blocks back from ${head} for call targets...`);

const targets = new Set();
const CHUNK = 10;
for (let start = head; start > head - NBLOCKS; start -= CHUNK) {
  const nums = [];
  for (let b = start; b > start - CHUNK && b > head - NBLOCKS; b--) nums.push(b);
  const blocks = await batch(nums.map(b => ({ method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] })), 10);
  for (const blk of blocks) for (const t of (blk?.transactions || [])) if (t.to) targets.add(t.to.toLowerCase());
  process.stdout.write('.');
}
console.log(`\n${targets.size} distinct call targets`);

// 2 — balance filter. One call each, kills the overwhelming majority.
const list = [...targets];
const bals = await batch(list.map(a => ({ method: 'eth_getBalance', params: [a, 'latest'] })), 60);
const funded = [];
list.forEach((a, i) => {
  const w = bals[i] ? BigInt(bals[i]) : 0n;
  const usd = px ? Number(formatUnits(w, 18)) * px : 0;
  if (usd >= MIN_USD) funded.push({ addr: a, wei: w, usd });
});
funded.sort((a, b) => b.usd - a.usd);
console.log(`${funded.length} hold >= $${MIN_USD} of native`);

// 3/4 — bytecode: does it expose an open release, and is it gated?
const codes = await batch(funded.map(f => ({ method: 'eth_getCode', params: [f.addr, 'latest'] })), 25);
const cands = [];
let readFailed = 0, eoa = 0;
funded.forEach((f, i) => {
  /* A null here is an RPC FAILURE, not an absence of code. Treating the two alike is the bug that made
   * this scanner report "0 funded contracts expose a value-releasing function" on its first run, while
   * a hand-check of the same chain found one in a sample of eight. Fourth instance of this exact class
   * in a single session; it is counted and printed now rather than folded silently into the zero. */
  if (codes[i] == null) { readFailed++; return; }
  const code = codes[i].toLowerCase();
  if (code === '0x') { eoa++; return; }
  const has = Object.keys(RELEASE).filter(s => s.length === 8 && code.includes(s));
  if (!has.length) return;
  const gated = GATES.filter(g => code.includes(g));
  cands.push({ ...f, fns: has.map(s => RELEASE[s]), sels: has, gated: gated.length, bytes: (code.length - 2) / 2 });
});
console.log(`  of ${funded.length} funded: ${eoa} EOAs, ${readFailed} CODE READS FAILED (unread, NOT zero), ${funded.length - eoa - readFailed} contracts actually examined`);
if (readFailed > funded.length * 0.2) console.log('  !! over a fifth of code reads failed — this run UNDER-REPORTS. Re-run before believing any zero.');
console.log(`${cands.length} funded contracts expose a value-releasing function\n`);
if (!cands.length) { console.log('nothing to simulate.'); process.exit(0); }

for (const c of cands.slice(0, 25)) {
  console.log(`  $${c.usd.toFixed(4).padStart(10)}  ${c.addr}  ${c.fns.join(', ')}${c.gated ? `  [${c.gated} gate(s) present]` : '  [NO owner/role gate found]'}`);
}

// 5 — the verdict: does it move value to ZERO, exactly as written?
console.log('\nsimulating from ZERO, keeping only what actually pays us...');
const hits = [];
for (const c of cands.slice(0, 40)) {
  for (const sel of c.sels) {
    const sim = await call('eth_simulateV1', [{
      blockStateCalls: [{ stateOverrides: { [ZERO]: { balance: '0x21e19e0c9bab2400000' } },
        calls: [{ from: ZERO, to: c.addr, data: '0x' + sel, value: '0x0' }] }],
      traceTransfers: true, validation: false,
    }, 'latest']);
    const r = sim?.[0]?.calls?.[0];
    if (!r || r.status !== '0x1') { process.stdout.write('.'); continue; }
    let got = 0n;
    for (const l of r.logs || []) {
      if ((l.topics?.[0] || '').toLowerCase() !== TRANSFER || (l.topics || []).length !== 3) continue;
      if (('0x' + l.topics[2].slice(26)).toLowerCase() !== ZERO.toLowerCase()) continue;
      got += BigInt((l.data || '0x0').slice(0, 66));
    }
    if (got > 0n) { hits.push({ ...c, sel, fn: RELEASE[sel], raw: got.toString(), gas: Number(BigInt(r.gasUsed || '0x0')) }); process.stdout.write('$'); }
    else process.stdout.write('o');
  }
}
console.log('\n');
if (!hits.length) {
  console.log('No funded contract released value to ZERO in this window.');
  console.log('That is a measurement about this window, not about the class — widen --blocks or change chain.');
} else {
  console.log('=== PAYS ZERO, EXACTLY AS THE CONTRACT IS WRITTEN ===');
  for (const h of hits) console.log(`  ${h.fn.padEnd(20)} gas ${String(h.gas).padStart(8)}  raw ${h.raw}  ${h.addr}`);
}
writeFileSync(path.join(HERE, 'attic-scan-result.json'), JSON.stringify({
  probedAt: new Date().toISOString(), chain, blocks: NBLOCKS, head,
  targets: targets.size, funded: funded.length, candidates: cands.length, hits,
  note: 'Open doors only: functions any caller may invoke as written. Never an exploit path.',
}, null, 1));
console.log(`\nsaved -> scripts/attic-scan-result.json`);
