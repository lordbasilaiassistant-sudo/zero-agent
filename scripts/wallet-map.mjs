#!/usr/bin/env node
/**
 * wallet-map.mjs — THE MAP. Who is being paid, right now, by anyone, on-chain — and could WE be?
 *
 * Supersedes scripts/freemoney-map.mjs (2026-08-20 rebuild). The question is unchanged and it is
 * still the right question: scan real blocks, find every transaction where value arrived AT THE
 * SENDER inside their own transaction, subtract everything that is merely a trade, and you have an
 * EMPIRICAL map of caller-paying mechanisms — including classes nobody has catalogued.
 *
 * WHY IT WAS REBUILT. The v1 map's own saved output is the argument. Measured 2026-08-20 from
 * scripts/freemoney-map-result.json (a base scan later overwritten by an arbitrum one):
 *
 *   1. PRICING SILENTLY DEAD. v1 priced tokens through a per-chain Blockscout `explorer` URL.
 *      Arbitrum's was `null`, so pricing was never attempted and every row came back $0.00 —
 *      including a 10,206 USDC payout (0xaf88…5831, 6 decimals) recorded as worthless.
 *   2. THE ZERO WAS A CLAIM ABOUT THE DETECTOR. v1 selected "permissionless" rows with
 *      `distinct_callers >= 2 && usd_per_call > 0`. Because every price was 0, the filter returned
 *      openPayers: 0 — while row 2 of the same file shows a contract with TEN distinct callers.
 *      The single most valuable finding in the scan was deleted by a pricing bug wearing a
 *      demand answer's clothes.
 *   3. NATIVE PAYOUTS WERE INVISIBLE. v1 read ERC-20 Transfer logs only. A contract that pays its
 *      caller in native ETH emits no log, so the largest class of keeper/harvest/refund bounties —
 *      the class our own top earner belongs to — could never appear at all.
 *   4. GAS WAS NEVER SUBTRACTED. Rows ranked on gross payout. A $0.002 bounty that costs $0.004 of
 *      gas ranked above a $0.003 bounty that costs $0.0001.
 *   5. THE MAP DID NOT ACCUMULATE. Each run overwrote the result file, so the base run worth
 *      $1,884 of observed payouts survives only as feature vectors inside scripts/brain-corpus.json.
 *      DOCTRINE.md §5 says the compounding asset is the accumulated map; the code threw it away.
 *   6. FAILURES WERE SILENT. A block whose RPC call threw was skipped by a bare `catch { continue }`
 *      without incrementing any counter, so "scanned 300 blocks" could mean 300 or 3.
 *
 * WHAT IS DIFFERENT HERE, and every one of these is measured, not assumed:
 *   · NATIVE ACCOUNTING, exact. nativeIn = bal(B) − bal(B−1) + tx.value + gasUsed×effGasPrice + l1Fee.
 *     The l1Fee term is mandatory on OP-stack chains (base/optimism/unichain) — omit it and every
 *     sender looks like they lost extra ETH, which understates inflow. Only applied where the sender
 *     has exactly one tx in the block; otherwise the row is marked native_unknown and never guessed.
 *   · PRICING that cannot fail silently. DefiLlama coins API (free, keyless, multi-chain, returns
 *     decimals + confidence). A token that cannot be priced is marked priced:false and routed to an
 *     `unpriced` bucket that is reported loudly — it is NEVER valued at 0 and never silently ranked last.
 *   · RANKING ON NET. payout_usd − gas_usd, with gross kept alongside.
 *   · CALLABILITY, then THE PAYOUT GATE — the two together are the point of the whole rebuild.
 *     eth_call FROM ZERO'S OWN ADDRESS separates "somebody gets paid" from "the contract will take
 *     this call from us". But acceptance is not payment, and assuming it was is how this rebuild
 *     nearly shipped two phantom routes: its first clean run graded two rows OPEN at $411.48 and
 *     $1.19 per call, and eth_simulateV1 with traceTransfers showed BOTH move exactly $0.00 to ZERO
 *     (a signed-payload relay, and a claim on someone else's position id). So every accepted row is
 *     re-simulated on the value that actually lands at our address — and then measured against gas,
 *     because the first two rows that ever cleared the payout gate paid $0.00031 and $0.000666 in VELO
 *     against ~$0.002 of gas apiece. Grades: PAYS · PAYS-BUT-LOSES · NO-PAY, and only PAYS is
 *     actionable. All of it is a read — no transaction, no signature, no capital.
 *   · CONTRACT FAMILIES. Payers are grouped by keccak(runtime bytecode) so one verdict predicts its
 *     siblings, matching how prospect.mjs makes elimination compound instead of merely accumulate.
 *   · A DURABLE, MERGED MAP at state/wallet-map.json — first_seen/last_seen/cumulative, never overwritten.
 *   · A CONTROL THAT BLOCKS THE WRITE. Per DOCTRINE: the instrument must rediscover a known specimen
 *     before you trust it. Pricing must re-derive a known stablecoin at ~$1 and a known WETH above
 *     $100; native accounting must reproduce a known ETH transfer to the wei. If a control fails the
 *     run exits non-zero and writes NOTHING, because a map that cannot price a dollar cannot be
 *     believed when it reports a zero.
 *   · HARD FAILURE ACCOUNTING. blocksAttempted / blocksScanned / blocksFailed are all reported.
 *
 * Usage:
 *   node scripts/wallet-map.mjs                          # default chain+window
 *   node scripts/wallet-map.mjs --chain base --blocks 300
 *   node scripts/wallet-map.mjs --chains base,optimism,arbitrum,gnosis,unichain --blocks 200
 *   node scripts/wallet-map.mjs --chain base --blocks 50 --no-probe    # skip callability + payout simulation
 *   node scripts/wallet-map.mjs --selftest                             # run controls only, write nothing
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, formatUnits } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state');

// ZERO's own address. Callability is graded from here — "can WE claim this", not "does anyone".
const ZERO_WALLET = '0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A';

/* ───────────────────────────── chains ─────────────────────────────
 * rpcs are ordered by measured reliability on 2026-08-20 (see the capability probe in the rebuild
 * session): batch JSON-RPC verified working on base/optimism/arbitrum/gnosis/unichain, absent on the
 * polygon endpoint that answered at all. `llama` is DefiLlama's chain key, which is NOT always the
 * chain's own name — gnosis is `xdai` there, and getting it wrong is a silent all-zero price column.
 */
const CHAINS = {
  base: {
    rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base.gateway.tenderly.co',
           'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io', 'https://1rpc.io/base'],
    llama: 'base', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: true,
  },
  optimism: {
    rpcs: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org', 'https://op-pokt.nodies.app',
           'https://mainnet.optimism.io'],
    llama: 'optimism', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: true,
  },
  arbitrum: {
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc',
           'https://arbitrum.drpc.org', 'https://1rpc.io/arb'],
    llama: 'arbitrum', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: false,
  },
  gnosis: {
    rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
    llama: 'xdai', nativeKey: 'coingecko:xdai', nativeSymbol: 'xDAI', opStack: false,
  },
  unichain: {
    rpcs: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org', 'https://unichain.drpc.org'],
    llama: 'unichain', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: true,
  },
  polygon: {
    rpcs: ['https://1rpc.io/matic'],
    llama: 'polygon', nativeKey: 'coingecko:matic-network', nativeSymbol: 'POL', opStack: false,
  },
  /* -- CHEAP-GAS CHAINS, added 2026-08-21 -------------------------------------------------------
   * The gnosis result generalised into a hypothesis worth scanning: gas is a DENOMINATOR, so the
   * same caller-paid relation that loses money on Base can be profitable wherever gas is small.
   * All probed 2026-08-21 for eth_getBlockReceipts + JSON-RPC batch (both required by this scanner);
   * baseFeePerGas measured the same minute and recorded, because "cheap" is the entire thesis.
   * simV1 marks whether eth_simulateV1 is available -- WITHOUT it the PAYS/NO-PAY payout gate cannot
   * run, and rows come back sim:'unavailable', which is NOT the same as verified-paying. */
  linea: {   // baseFee ~0 gwei · no simV1
    rpcs: ['https://rpc.linea.build', 'https://linea.drpc.org'],
    llama: 'linea', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: false,
  },
  blast: {   // baseFee ~0 gwei · no simV1
    rpcs: ['https://rpc.blast.io', 'https://blast.drpc.org'],
    llama: 'blast', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: true,
  },
  mode: {    // baseFee ~0 gwei · simV1 YES -> full payout gate available
    rpcs: ['https://mainnet.mode.network'],
    llama: 'mode', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: true,
  },
  fraxtal: { // baseFee ~0 gwei · no simV1
    rpcs: ['https://rpc.frax.com'],
    llama: 'fraxtal', nativeKey: 'coingecko:frax-ether', nativeSymbol: 'frxETH', opStack: true,
  },
  opbnb: {   // baseFee ~0 gwei · no simV1
    rpcs: ['https://opbnb-mainnet-rpc.bnbchain.org'],
    llama: 'op_bnb', nativeKey: 'coingecko:binancecoin', nativeSymbol: 'BNB', opStack: true,
  },
  scroll: {  // baseFee 0.00012 gwei · no simV1
    rpcs: ['https://rpc.scroll.io', 'https://scroll.drpc.org'],
    llama: 'scroll', nativeKey: 'coingecko:ethereum', nativeSymbol: 'ETH', opStack: false,
  },
  sonic: {   // baseFee 50 gwei but S is cheap · simV1 YES
    rpcs: ['https://rpc.soniclabs.com'],
    llama: 'sonic', nativeKey: 'coingecko:sonic-3', nativeSymbol: 'S', opStack: false,
  },
  mantle: {  // baseFee 50 gwei, MNT cheap · simV1 YES
    rpcs: ['https://rpc.mantle.xyz', 'https://mantle.drpc.org'],
    llama: 'mantle', nativeKey: 'coingecko:mantle', nativeSymbol: 'MNT', opStack: true,
  },
  celo: {    // baseFee 200 gwei, CELO cheap · no simV1
    rpcs: ['https://forno.celo.org', 'https://celo.drpc.org'],
    llama: 'celo', nativeKey: 'coingecko:celo', nativeSymbol: 'CELO', opStack: false,
  },
};

/* Controls: known specimens the instrument must rediscover before its output may be written.
 * These are deliberately boring, long-lived, high-liquidity tokens — if DefiLlama cannot price
 * USDC, the price column is broken and every "no payers found" verdict in the run is unreadable. */
const PRICE_CONTROLS = [
  { chain: 'arbitrum', addr: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', sym: 'USDC', min: 0.90, max: 1.10 },
  { chain: 'base', addr: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', sym: 'USDC', min: 0.90, max: 1.10 },
  { chain: 'base', addr: '0x4200000000000000000000000000000000000006', sym: 'WETH', min: 100, max: 100000 },
];

/* INFRASTRUCTURE PASSTHROUGHS — generic aggregators that carry somebody else's intent.
 * Value "arriving at the sender" through Multicall3 is the sender's own batched call coming home,
 * not a fee the contract paid. It grades OPEN on the probe (anyone may call Multicall3) which would
 * put a pure artifact at the top of the actionable list. Excluded by address, on every chain — the
 * deployment address is identical across all of them. */
const PASSTHROUGH_CONTRACTS = new Set([
  '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3
]);

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH_DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';   // Deposit(address,uint256)
const WETH_WITHDRAW = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65'; // Withdrawal(address,uint256)

// Anything whose PURPOSE is to hand you tokens back is not a payout — it is a trade. Excluded by role,
// because netting alone cannot distinguish "the AMM gave me my swap output" from "the vault paid me".
const TRADE_SELECTORS = new Set([
  '0x38ed1739', '0x7ff36ab5', '0x18cbafe5', '0x8803dbee', '0x5c11d795', '0x791ac947', '0xb6f9de95', // univ2
  '0x414bf389', '0xc04b8d59', '0xdb3e2198', '0xf28c0498', '0x04e45aaf', '0x5023b4df', '0xb858183f', // univ3
  '0x3593564c', // universal router
  '0xac9650d8', // multicall (router)
  '0x2e95b6c8', '0x12aa3caf', '0x0502b1c5', '0xe449022e', '0x84bd6d29', // 1inch
  '0xd0e30db0', '0x2e1a7d4d',                 // weth deposit / withdraw
  '0xa9059cbb', '0x23b872dd', '0x095ea7b3',   // transfer / transferFrom / approve
  '0x1249c58b', '0x40c10f19',                 // mint / mint(address,uint256)
  '0x2f2ff15d', '0x36568abe',                 // grantRole / renounceRole
]);

/* PRINCIPAL-SHAPED SELECTORS — the false-positive class that survives every other filter.
 *
 * withdraw() / claim() / exit() / redeem() all produce a textbook payout shape: value arrives at the
 * sender, nothing leaves, no trade selector. But it is the caller's OWN money coming back, not a fee
 * for work. The first run of this scanner ranked a 1,043,573-token `withdraw()` (0x3ccfd60b) as a top
 * payer for exactly this reason, and a $187k family alongside it.
 *
 * These are NOT dropped — a contract can pay a real bounty through a claim-shaped name, and dropping
 * them would be the same silent-deletion mistake v1 made with pricing. They are marked `principal`,
 * held out of the headline ranking, and settled by the callability probe: a withdraw() simulated FROM
 * ZERO, who never deposited, returns nothing. That is the discriminator, and it is a measurement. */
const PRINCIPAL_SELECTORS = new Set([
  '0x3ccfd60b', // withdraw()
  '0x853828b6', // withdrawAll()
  '0x441a3e70', // withdraw(uint256,uint256)
  '0xf3fef3a3', // withdraw(address,uint256)
  '0x69328dec', // withdraw(address,uint256,address)
  '0x00f714ce', // withdraw(uint256,address)
  '0x4e71d92d', // claim()
  '0x1e83409a', // claim(address)
  '0x379607f5', // claim(uint256)
  '0xd279c191', // claim(address,uint256)
  '0xe9fad8ee', // exit()
  '0xdb2e21bc', // exit()
  '0xdb006a75', // redeem(uint256)
  '0x852a12e3', // redeemUnderlying(uint256)
  '0x2e17de78', // unstake(uint256)
  '0xa694fc3a', // stake(uint256)
  '0xb6b55f25', // deposit(uint256)
  '0xe2bbb158', // deposit(uint256,uint256)
  '0x9ee679e8', // withdrawTokens
  '0x51cff8d9', // withdraw(address)
]);

/* ───────────────────────────── cli ───────────────────────────── */
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const SELFTEST_ONLY = flag('selftest');
const NBLOCKS = Number(opt('blocks', 200));
// A contract called once in the whole window is a coincidence, not a route. Native resolution is
// spent only on contracts that were called at least this many times. Reported, never silent.
const MIN_REPEAT = Number(opt('min-repeat', 2));
// Bounds the run. Native resolution is spent on the most-repeatedly-called contracts first; anything
// beyond the cap is reported as native_deferred, never dropped in silence.
const NATIVE_CAP = Number(opt('native-cap', 2500));
const RPC_CONCURRENCY = Number(opt('concurrency', 4));
const NATIVE_PREFILTER = opt('native-prefilter', 'balance') !== 'none';
const DO_PROBE = !flag('no-probe');
const PROBE_TOP = Number(opt('probe-top', 25));
const CHAIN_LIST = (opt('chains', opt('chain', 'base'))).split(',').map(s => s.trim()).filter(Boolean);

/* -- self-test: node scripts/wallet-map.mjs --test-clusters (no network, exits immediately) ------ */
function selfTestClusters() {
  const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
  const fleet = Array.from({ length: 48 }, (_, i) => '0x4337' + String(i).padStart(36, '0'));
  const indies = ['0xf0f772fa5f01bc19064a8ba323a4f53505586ce1a', '0x79c02f38dba39da361b4a0484c40351d50d55a94',
                  '0xf03ddbe5b9b4ddec66009d94dc5d33dd719f34e1', '0x11b8ad91a30b432a684665529bda81f56e842cbf'];
  const r = operatorClusters([...fleet, ...indies]);
  if (r.addresses !== 52) fail('should see 52 addresses, saw ' + r.addresses);
  if (r.operators !== 5) fail('48 vanity + 4 independents = 5 operators, got ' + r.operators);
  if (!r.fleets.length || r.fleets[0].prefix !== '0x4337') fail('should flag the 0x4337 fleet');

  const clean = operatorClusters(['0xaa11111111111111111111111111111111111111',
                                  '0xbb22222222222222222222222222222222222222',
                                  '0xcc33333333333333333333333333333333333333']);
  if (clean.operators !== 3) fail('three unrelated addresses are three operators');
  if (clean.fleets.length) fail('must NOT invent a fleet where none exists');

  const pair = operatorClusters(['0x43370000000000000000000000000000000000aa',
                                 '0x43370000000000000000000000000000000000bb']);
  if (pair.fleets.length) fail('two sharing a prefix is under the threshold - do not cry fleet');

  console.log('operatorClusters: 3/3 self-tests pass (1 asserts it stays SILENT on a clean set)');
  process.exit(0);
}


for (const c of CHAIN_LIST) {
  if (!CHAINS[c]) { console.error(`unknown chain "${c}". known: ${Object.keys(CHAINS).join(', ')}`); process.exit(2); }
}

/* ───────────────────────────── rpc ─────────────────────────────
 * Failover across endpoints, JSON-RPC batching where the endpoint supports it (probed once, never
 * assumed), sequential fallback where it does not, and retries. Every failure is counted; nothing
 * is skipped silently. */
const rpcState = {};      // chain -> { url, batch, blockReceipts }
const rpcTried = {};      // chain -> Set(url) already burned this run
const rpcBurst = {};      // chain -> consecutive batch failures on the current endpoint
const rpcChunk = {};      // chain -> learned max batch size. Deliberately NOT on rpcState: that
                          // object is nulled by rotateEndpoint(), and writing the learned chunk to it
                          // crashed base mid-scan once the two paths raced.

/* Rotate to the next endpoint when the current one starts refusing in bursts. Public RPCs do not
 * return "429, slow down" so much as they simply stop answering batches, which shows up here as a
 * wall of nulls. The first full run took 2,560 such errors on base and absorbed them as gaps in the
 * native column. With several measured endpoints per chain, the right response is to move, not to
 * quietly lose data. */
function rotateEndpoint(chain) {
  const cur = rpcState[chain]?.url;
  (rpcTried[chain] ||= new Set()).add(cur);
  const next = CHAINS[chain].rpcs.find(u => !rpcTried[chain].has(u));
  rpcState[chain] = null;
  rpcBurst[chain] = 0;
  if (next) console.log(`  [${chain}] endpoint ${cur} is refusing in bursts → rotating to ${next}`);
  return next;
}

async function rawPost(url, body, ms = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ac.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* A POOL, not a single endpoint. One public RPC will not carry the balance-diff storm that exact
 * native accounting requires: base logged 2,560 errors on the first full run and still 1,428 after
 * retries, because every request went to the same host. Spreading chunks round-robin across every
 * endpoint that passed the capability probe cuts per-host load by the size of the pool, and a host
 * that starts refusing is stepped around rather than retried into the ground. */
const rpcPool = {}; // chain -> [{url, batch, blockReceipts, fails}]

async function buildPool(chain, want = 3) {
  if (rpcPool[chain] && rpcPool[chain].length) return rpcPool[chain];
  const pool = [];
  for (const url of CHAINS[chain].rpcs) {
    if (pool.length >= want) break;
    try {
      const bn = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 12000);
      if (!bn.result) continue;
      const probeBlock = '0x' + (Number(bn.result) - 3).toString(16);
      const rcpt = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockReceipts', params: [probeBlock] }, 20000).catch(() => ({}));
      const blockReceipts = Array.isArray(rcpt.result);
      let batch = false;
      try {
        const b = await rawPost(url, [
          { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
          { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
        ], 12000);
        batch = Array.isArray(b) && b.length === 2 && b.every(x => x && x.result);
      } catch { batch = false; }
      // Keep non-batch hosts too: they are still useful to spread a sequential fallback across, which
      // is precisely the situation where the primary host is already refusing us.
      pool.push({ url, batch, blockReceipts, fails: 0 });
    } catch { /* next */ }
  }
  rpcPool[chain] = pool;
  if (pool.length) console.log('  [' + chain + '] pool of ' + pool.length + ': ' + pool.map(e => e.url).join(', '));
  return pool;
}

async function pickEndpoint(chain) {
  if (rpcState[chain]) return rpcState[chain];
  for (const url of CHAINS[chain].rpcs) {
    if (rpcTried[chain]?.has(url)) continue;
    try {
      const bn = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 15000);
      if (!bn.result) continue;
      // probe receipts + batch support once, so neither is ever assumed
      const probeBlock = '0x' + (Number(bn.result) - 3).toString(16);
      // Accept an endpoint that can produce receipts EITHER way. Requiring eth_getBlockReceipts left
      // base with exactly one usable endpoint, and when that one rate-limited us mid-session the whole
      // chain went dark and the control gate (correctly) refused to write. One optional method must
      // never be a single point of failure.
      const rcpt = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockReceipts', params: [probeBlock] }, 20000)
        .catch(() => ({}));
      let blockReceipts = Array.isArray(rcpt.result);
      if (!blockReceipts) {
        const blk = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [probeBlock, false] }, 20000).catch(() => ({}));
        const h = blk.result?.transactions?.[0];
        if (!h) continue;
        const one = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [h] }, 20000).catch(() => ({}));
        if (!one.result) continue; // truly cannot give us receipts at all
      }
      let batch = false;
      try {
        const b = await rawPost(url, [
          { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
          { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
        ], 15000);
        batch = Array.isArray(b) && b.length === 2 && b.every(x => x && x.result);
      } catch { batch = false; }
      rpcState[chain] = { url, batch, blockReceipts };
      console.log(`  [${chain}] endpoint ${url} · blockReceipts=${blockReceipts} · batch=${batch}`);
      return rpcState[chain];
    } catch { /* try the next endpoint */ }
  }
  throw new Error(`no usable RPC for ${chain} (need eth_getBlockReceipts)`);
}

const stats = {}; // chain -> counters
function S(chain) {
  return stats[chain] ||= {
    blocksAttempted: 0, blocksScanned: 0, blocksFailed: 0, rpcErrors: 0,
    txsExamined: 0, txsSkippedTrade: 0, payoutShaped: 0,
    nativeChecked: 0, nativeUnknown: 0, nftLogsIgnored: 0, singletonsSkipped: 0, nativeDeferred: 0, passthroughSkipped: 0, nativePrefiltered: 0,
  };
}

/** Batched RPC. `calls` = [{method, params}]. Returns results in order; throws only if the whole
 *  transport fails. Individual call errors come back as null and are counted. */
async function rpcMany(chain, calls, chunkSize = 40) {
  if (!calls.length) return [];
  const st0 = await pickEndpoint(chain);
  const { url, batch } = st0;
  if (rpcChunk[chain]) chunkSize = Math.min(chunkSize, rpcChunk[chain]);
  const out = new Array(calls.length).fill(null);

  if (!batch) {
    const seqPool = (rpcPool[chain] && rpcPool[chain].length) ? rpcPool[chain] : [{ url, fails: 0 }];
    let idx = 0;
    const seqWorker = async (w) => {
      while (idx < calls.length) {
        const i = idx++;
        for (let attempt = 0; attempt < 3; attempt++) {
          const live = seqPool.filter(e => e.fails < 8);
          const ep = (live.length ? live : seqPool)[(i + attempt + w) % (live.length || seqPool.length)];
          try {
            const j = await rawPost(ep.url, { jsonrpc: '2.0', id: i, method: calls[i].method, params: calls[i].params });
            if (j && j.result !== undefined && !j.error) { out[i] = j.result; ep.fails = 0; break; }
            if (j && j.error) { S(chain).rpcErrors++; break; }
          } catch {
            ep.fails++;
            if (attempt === 2) S(chain).rpcErrors++; else await sleep(300 * (attempt + 1));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RPC_CONCURRENCY, calls.length) }, (_, w) => seqWorker(w)));
    return out;
  }

  // Chunks run through a small concurrency pool, spread across every healthy endpoint. Sequential
  // chunks against one host were the two largest costs in the first build — minutes of round-trip,
  // then thousands of throttled requests.
  const pool = (rpcPool[chain] && rpcPool[chain].length) ? rpcPool[chain] : [{ url, batch, fails: 0 }];
  const jobs = [];
  for (let start = 0; start < calls.length; start += chunkSize) jobs.push(start);
  let cursor = 0;
  const worker = async (workerIdx) => {
    while (cursor < jobs.length) {
      const myJob = cursor++;
      const start = jobs[myJob];
      const slice = calls.slice(start, start + chunkSize);
      const body = slice.map((c, i) => ({ jsonrpc: '2.0', id: start + i, method: c.method, params: c.params }));
      let got = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Rotate hosts per attempt as well as per job, so a throttling host is stepped around
        // instead of being hammered three times.
        const live = pool.filter(e => e.fails < 4);
        const ep = (live.length ? live : pool)[(myJob + attempt + workerIdx) % (live.length || pool.length)];
        try { got = await rawPost(ep.url, body); ep.fails = 0; break; }
        catch {
          ep.fails++;
          // Spreading load onto a host that keeps refusing makes the run WORSE, not better: adding a
          // rate-limited endpoint to the pool took base from 1,428 errors to 2,335. A host that has
          // failed four times is benched for the rest of the run.
          if (ep.fails === 4 && pool.filter(e => e.fails < 4).length >= 1) {
            console.log('  [' + chain + '] benching ' + ep.url + ' after repeated refusals');
          }
          if (attempt === 2) { S(chain).rpcErrors += slice.length; } else await sleep(300 * (attempt + 1));
        }
      }
      if (!Array.isArray(got)) {
        // Endpoints differ wildly in how large a batch they will take, and none of them say so.
        // Shrink first — a smaller batch usually succeeds where a big one is dropped — and only
        // rotate once shrinking has stopped helping.
        const shrunk = Math.max(4, Math.floor(chunkSize / 2));
        if (shrunk < chunkSize) {
          rpcChunk[chain] = shrunk;
          const retry = [];
          for (let i = 0; i < slice.length; i += shrunk) {
            const sub = slice.slice(i, i + shrunk).map((c, k) => ({ jsonrpc: '2.0', id: start + i + k, method: c.method, params: c.params }));
            const host = (pool.filter(e => e.fails < 4)[0] || pool[0] || { url }).url;
            try { const r = await rawPost(host, sub); if (Array.isArray(r)) retry.push(...r); } catch { /* counted below */ }
          }
          if (retry.length) {
            for (const r of retry) if (r && typeof r.id === 'number' && !r.error) out[r.id] = r.result;
            rpcBurst[chain] = 0;
            continue;
          }
        }
        if ((rpcBurst[chain] = (rpcBurst[chain] || 0) + 1) >= 3 && rotateEndpoint(chain)) {
          try { await pickEndpoint(chain); } catch { /* out of endpoints; errors stay counted */ }
        }
        continue;
      }
      rpcBurst[chain] = 0;
      for (const r of got) {
        if (r && typeof r.id === 'number') {
          if (r.error) S(chain).rpcErrors++;
          else out[r.id] = r.result;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RPC_CONCURRENCY, jobs.length) }, (_, i) => worker(i)));

  // A rate-limited batch returns nothing for every id it carried. The first full run logged 2,560
  // such errors on base — 40/40 blocks "scanned" while half the native checks quietly came back
  // null. Retry the gaps one at a time; whatever is still missing is reported, never assumed empty.
  const gaps = [];
  for (let i = 0; i < out.length; i++) if (out[i] == null) gaps.push(i);
  if (gaps.length && gaps.length < calls.length) {
    let gcur = 0;
    const gworker = async () => {
      while (gcur < gaps.length) {
        const i = gaps[gcur++];
        try {
          const ep = pool[i % pool.length];
          const j = await rawPost(ep.url, { jsonrpc: '2.0', id: i, method: calls[i].method, params: calls[i].params }, 20000);
          if (j && !j.error && j.result !== undefined) { out[i] = j.result; S(chain).rpcErrors = Math.max(0, S(chain).rpcErrors - 1); }
        } catch { /* stays null and stays counted */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, gaps.length) }, gworker));
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const topicAddr = (t) => '0x' + (t || '').slice(26).toLowerCase();
const hexToBig = (h) => { try { return h && h !== '0x' ? BigInt(h) : 0n; } catch { return 0n; } };

/* ───────────────────────────── pricing ─────────────────────────────
 * DefiLlama coins API: free, keyless, multi-chain, returns price + decimals + symbol + confidence.
 * A token we cannot price is marked priced:false. It is never valued at $0 — that conflation is
 * exactly what made v1 report "no permissionless payers" while holding a 10,206 USDC row. */
const priceCache = new Map(); // "chain:addr" | nativeKey -> {price, decimals, symbol, confidence} | null

async function fetchLlama(keys) {
  const missing = keys.filter(k => !priceCache.has(k));
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 25000);
        const r = await fetch('https://coins.llama.fi/prices/current/' + chunk.join(','), { signal: ac.signal });
        clearTimeout(t);
        const j = await r.json();
        for (const k of chunk) {
          const c = j.coins?.[k];
          priceCache.set(k, c && typeof c.price === 'number'
            ? { price: c.price, decimals: c.decimals ?? 18, symbol: c.symbol || '?', confidence: c.confidence ?? 0 }
            : null);
        }
        ok = true;
      } catch { await sleep(600 * (attempt + 1)); }
    }
    if (!ok) for (const k of chunk) if (!priceCache.has(k)) priceCache.set(k, null);
  }
}

const tokenKey = (chain, addr) => `${CHAINS[chain].llama}:${addr.toLowerCase()}`;

/** Decimals for tokens DefiLlama could not resolve — read from the chain so raw amounts stay meaningful. */
async function fillMissingDecimals(chain, addrs) {
  const need = addrs.filter(a => !priceCache.get(tokenKey(chain, a)));
  if (!need.length) return {};
  const res = await rpcMany(chain, need.map(a => ({
    method: 'eth_call', params: [{ to: a, data: '0x313ce567' }, 'latest'], // decimals()
  })));
  const out = {};
  need.forEach((a, i) => { const v = res[i]; out[a.toLowerCase()] = v && v !== '0x' ? Number(BigInt(v)) : null; });
  return out;
}

/* EXECUTABLE vs SPOT — global CLAUDE.md §10 names "confuse spot with executable prices" as an
 * anti-pattern that has already burned us, and this map walked straight into it: the first full run's
 * two best rows were $142.53 and $89.32 per call, both denominated in one obscure token (TKFG).
 * DefiLlama's confidence on it is 0.99, so the PRICE is sound — but a sound quote for a thin market is
 * not money we could realise. Nine thousand tokens do not leave at the quoted price.
 *
 * So a payout is EXECUTABLE only if it arrives in something ZERO can actually hold or spend: the
 * chain's native coin, canonical WETH, or a major stablecoin. Everything else is priced, ranked, and
 * kept — flagged `spot_only`, and never allowed to head the actionable list on quote alone. */
const EXECUTABLE_TOKENS = new Set([
  '0x4200000000000000000000000000000000000006', // WETH — base / optimism / unichain (OP-stack canonical)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC base
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC optimism
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC arbitrum
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e arbitrum
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH arbitrum
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT arbitrum
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT optimism
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI optimism / arbitrum
  '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d', // WXDAI gnosis
  '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0', // USDC.e gnosis
  '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1', // WETH gnosis
]);

/* ───────────────────────────── controls ─────────────────────────────
 * Blocking. A map that cannot price a dollar cannot be believed when it reports a zero. */
async function runControls(chains) {
  const results = [];

  // 1. pricing must re-derive known specimens
  await fetchLlama(PRICE_CONTROLS.map(c => tokenKey(c.chain, c.addr)));
  for (const c of PRICE_CONTROLS) {
    const p = priceCache.get(tokenKey(c.chain, c.addr));
    const pass = !!p && p.price >= c.min && p.price <= c.max;
    results.push({
      control: `price ${c.sym} on ${c.chain}`, pass,
      detail: p ? `$${p.price} (expected ${c.min}–${c.max}, confidence ${p.confidence})` : 'UNPRICED — pricing source failed',
    });
  }

  // 2. native accounting must reproduce a known plain ETH transfer, to the wei.
  //    We search recent blocks for a value-bearing transfer to a recipient who neither sends nor
  //    receives anything else in that block, then assert bal(B) − bal(B−1) === value exactly.
  const chain = chains[0];
  /* Three states, not two. A control that cannot find a specimen has not FAILED -- it has not RUN,
   * and conflating those is the same error this whole scanner exists to avoid. On a quiet chain
   * (mode, fraxtal) there may simply be no plain-value transfer with an unambiguous recipient in
   * the window, and refusing to write the map because the chain was quiet is a bug, not rigour.
   * A specimen found and MISMATCHED is still a hard fail. */
  let nativeCtl = { control: `native accounting on ${chain}`, pass: true, inconclusive: true,
                    detail: 'INCONCLUSIVE - no unambiguous plain-transfer specimen in the window (chain too quiet); native accounting unverified this run' };
  try {
    const head = Number((await rpcMany(chain, [{ method: 'eth_blockNumber', params: [] }]))[0]);
    outer:
    for (let b = head - 2; b > head - 160; b--) {
      const [blk] = await rpcMany(chain, [{ method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] }]);
      if (!blk?.transactions?.length) continue;
      const txs = blk.transactions;
      const senders = new Map(), receivers = new Map();
      for (const t of txs) {
        senders.set(t.from.toLowerCase(), (senders.get(t.from.toLowerCase()) || 0) + 1);
        if (t.to) receivers.set(t.to.toLowerCase(), (receivers.get(t.to.toLowerCase()) || 0) + 1);
      }
      for (const t of txs) {
        if (!t.to) continue;
        const to = t.to.toLowerCase();
        const val = hexToBig(t.value);
        if (val <= 0n) continue;
        if ((senders.get(to) || 0) !== 0) continue;      // recipient must not spend in this block
        if ((receivers.get(to) || 0) !== 1) continue;    // and must be paid exactly once
        if ((t.input || '0x') !== '0x') continue;        // plain transfer: no contract logic to move more
        const [after, before] = await rpcMany(chain, [
          { method: 'eth_getBalance', params: [to, '0x' + b.toString(16)] },
          { method: 'eth_getBalance', params: [to, '0x' + (b - 1).toString(16)] },
        ]);
        if (!after || !before) continue;
        const delta = hexToBig(after) - hexToBig(before);
        const pass = delta === val;
        nativeCtl = {
          control: `native accounting on ${chain}`, pass, inconclusive: false,
          detail: pass
            ? `block ${b} tx ${t.hash.slice(0, 12)}… delta ${delta} wei === value ${val} wei`
            : `block ${b} tx ${t.hash.slice(0, 12)}… delta ${delta} !== value ${val} (internal transfers present?)`,
        };
        if (pass) break outer;
      }
    }
  } catch (e) {
    nativeCtl.detail = 'INCONCLUSIVE - control errored: ' + String(e.message || e).slice(0, 100);
    nativeCtl.pass = true; nativeCtl.inconclusive = true;
  }
  results.push(nativeCtl);

  return results;
}

/* ───────────────────────────── the scan ─────────────────────────────
 * TWO PHASES, deliberately.
 *
 * Phase 1 reads every block and does all the log-based (ERC-20) accounting, which is free — the
 * receipts are already in hand. It also parks every transaction that COULD still hold a hidden
 * native payout.
 *
 * Phase 2 resolves those native payouts with exact balance diffs. The naive version of this checks
 * every sender in every block — on base that is ~150 senders × 2 balance reads per block, and it is
 * what made the first run of this scanner too slow to finish. The filter that fixes it is not a
 * speed hack, it is the actual definition of what we are hunting: a contract called ONCE in the whole
 * window is not a route, it is a coincidence. We want repeat-callable payers. So native resolution
 * runs only for transactions whose target contract was seen at least MIN_REPEAT times in the window,
 * which collapses the work by one to two orders of magnitude and drops nothing we would have kept.
 * Single-shot contracts are still counted and reported under `singletons` so the exclusion is visible
 * rather than silent. */
async function scanChain(chain, nblocks) {
  const st = S(chain);
  const { url, batch, blockReceipts } = await pickEndpoint(chain);
  await buildPool(chain);
  const head = Number((await rpcMany(chain, [{ method: 'eth_blockNumber', params: [] }]))[0]);
  if (!Number.isFinite(head)) throw new Error(`${chain}: could not read head block`);
  console.log(`\n[${chain}] rpc=${url} batch=${batch} · scanning ${nblocks} blocks back from ${head}`);

  const payers = new Map();      // `${contract}:${selector}` -> record
  const tokensSeen = new Set();
  const BLOCK_CHUNK = batch ? 8 : 2;

  const pending = [];              // every candidate, across the whole window
  const contractCalls = new Map(); // contract -> times called in window

  for (let start = head; start > head - nblocks; start -= BLOCK_CHUNK) {
    const nums = [];
    for (let b = start; b > start - BLOCK_CHUNK && b > head - nblocks; b--) nums.push(b);
    st.blocksAttempted += nums.length;

    const calls = [];
    for (const b of nums) {
      calls.push({ method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] });
      if (blockReceipts) calls.push({ method: 'eth_getBlockReceipts', params: ['0x' + b.toString(16)] });
    }
    const raw = await rpcMany(chain, calls, batch ? 16 : 1);

    // Normalise to [block, receipts] pairs regardless of which method the endpoint supports.
    const res = [];
    if (blockReceipts) {
      for (let i = 0; i < nums.length; i++) { res.push(raw[i * 2], raw[i * 2 + 1]); }
    } else {
      // Fallback: pull receipts per transaction. More calls, but it works on every endpoint we found,
      // which is what keeps a single optional method from taking a whole chain offline.
      const hashes = [];
      for (let i = 0; i < nums.length; i++) for (const t of (raw[i]?.transactions || [])) hashes.push(t.hash);
      const rcpts = await rpcMany(chain, hashes.map(h => ({ method: 'eth_getTransactionReceipt', params: [h] })), batch ? 25 : 1);
      const byHash = new Map();
      hashes.forEach((h, i) => { if (rcpts[i]) byHash.set(h, rcpts[i]); });
      for (let i = 0; i < nums.length; i++) {
        const blk = raw[i];
        res.push(blk, blk ? (blk.transactions || []).map(t => byHash.get(t.hash)).filter(Boolean) : null);
      }
    }

    for (let i = 0; i < nums.length; i++) {
      const b = nums[i];
      const block = res[i * 2];
      const receipts = res[i * 2 + 1];
      if (!block || !Array.isArray(receipts)) { st.blocksFailed++; continue; }
      st.blocksScanned++;

      const byHash = Object.fromEntries((block.transactions || []).map(t => [t.hash, t]));
      const senderTxCount = new Map();
      for (const t of block.transactions || []) {
        const f = t.from.toLowerCase();
        senderTxCount.set(f, (senderTxCount.get(f) || 0) + 1);
      }

      for (const rc of receipts) {
        const tx = byHash[rc.transactionHash];
        if (!tx || !tx.to || rc.status !== '0x1') continue;
        st.txsExamined++;
        const sender = tx.from.toLowerCase();
        const selector = (tx.input || '0x').slice(0, 10);
        if (selector.length < 10) continue;                       // plain value send, not a call
        if (TRADE_SELECTORS.has(selector)) { st.txsSkippedTrade++; continue; }
        if (PASSTHROUGH_CONTRACTS.has(tx.to.toLowerCase())) { st.passthroughSkipped++; continue; }

        // ---- ERC-20 side: net token flow at the sender ----
        const inflow = {}, outflow = {};
        for (const log of rc.logs || []) {
          const t0 = (log.topics?.[0] || '').toLowerCase();
          const token = log.address.toLowerCase();
          if (t0 === TRANSFER) {
            // ERC-721 shares this topic but indexes tokenId as a 4th topic and carries empty data.
            // v1 let those through as zero-amount inflows; count and drop them explicitly.
            if ((log.topics || []).length === 4) { st.nftLogsIgnored++; continue; }
            if ((log.topics || []).length < 3) continue;
            const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]);
            const amt = hexToBig((log.data || '0x').slice(0, 66));
            if (to === sender) inflow[token] = (inflow[token] ?? 0n) + amt;
            if (from === sender) outflow[token] = (outflow[token] ?? 0n) + amt;
          } else if (t0 === WETH_DEPOSIT && topicAddr(log.topics?.[1]) === sender) {
            outflow[token] = (outflow[token] ?? 0n) + hexToBig((log.data || '0x').slice(0, 66)); // wrapping own ETH is not income
          } else if (t0 === WETH_WITHDRAW && topicAddr(log.topics?.[1]) === sender) {
            inflow[token] = (inflow[token] ?? 0n) - hexToBig((log.data || '0x').slice(0, 66));   // unwrapping is not income either
          }
        }
        const net = {};
        let anyTokenOut = false;
        for (const [tok, amt] of Object.entries(outflow)) if (amt > 0n) anyTokenOut = true;
        for (const [tok, amt] of Object.entries(inflow)) {
          const n = amt - (outflow[tok] ?? 0n);
          if (n > 0n) net[tok] = n;
        }

        const valueSent = hexToBig(tx.value);
        const soleSender = (senderTxCount.get(sender) || 0) === 1;

        // Candidate if tokens netted in, OR if native accounting could still reveal an inflow.
        const tokenPayout = Object.keys(net).length > 0 && !anyTokenOut;
        if (!tokenPayout && !soleSender) { st.nativeUnknown++; continue; }

        const target = tx.to.toLowerCase();
        contractCalls.set(target, (contractCalls.get(target) || 0) + 1);
        pending.push({ b, tx, rc, net, tokenPayout, anyTokenOut, valueSent, soleSender, selector, sender, target });
        for (const t of Object.keys(net)) tokensSeen.add(t);
      }
    }

    if (st.blocksScanned && st.blocksScanned % 40 < BLOCK_CHUNK) {
      console.log(`  …${st.blocksScanned}/${st.blocksAttempted} blocks · ${st.txsExamined} txs · ${pending.length} candidates`);
    }
  }

  // ── phase 2: exact native deltas, but only where a repeat-callable contract makes it worth asking
  const repeatable = pending.filter(p => p.tokenPayout || (p.soleSender && (contractCalls.get(p.target) || 0) >= MIN_REPEAT));
  st.singletonsSkipped = pending.length - repeatable.length;

  /* PRE-FILTER BY THE PAYER'S OWN BALANCE. Exact native accounting costs two balance reads per
   * candidate transaction, and on base that was ~2,000 reads per 20 blocks -- enough to get throttled
   * by every public RPC we have. But there are far fewer distinct CONTRACTS than transactions, and a
   * contract holding zero native cannot pay native. One balance read per contract replaces hundreds
   * per contract's transactions.
   *
   * Honest limitation, stated rather than buried: a contract that receives native inside the same
   * transaction and forwards it on would hold a zero balance beforehand and is skipped here. That is
   * a real false-negative class. It is reported as nativePrefiltered, and `--native-prefilter none`
   * turns it off when a slow, exhaustive pass is wanted. */
  let nativeCandidates = repeatable.filter(p => p.soleSender);
  if (NATIVE_PREFILTER) {
    const contracts = [...new Set(nativeCandidates.map(p => p.target))];
    const bals = await rpcMany(chain, contracts.map(c => ({ method: 'eth_getBalance', params: [c, 'latest'] })), batch ? 25 : 1);
    const funded = new Set();
    contracts.forEach((c, i) => { if (bals[i] != null && hexToBig(bals[i]) > 0n) funded.add(c); });
    const before = nativeCandidates.length;
    nativeCandidates = nativeCandidates.filter(p => p.tokenPayout || funded.has(p.target));
    st.nativePrefiltered = before - nativeCandidates.length;
    console.log('  phase 2 pre-filter: ' + contracts.length + ' contracts checked, ' + funded.size +
                ' hold native; ' + st.nativePrefiltered + ' candidates dropped as unable to pay native');
  }
  // Spend what is left of the native budget on the busiest contracts first.
  nativeCandidates.sort((a, b) => (contractCalls.get(b.target) || 0) - (contractCalls.get(a.target) || 0));
  const balanceNeeds = new Map();
  for (const p of nativeCandidates) {
    const key = `${p.sender}:${p.b}`;
    if (balanceNeeds.size >= NATIVE_CAP && !balanceNeeds.has(key)) { st.nativeDeferred++; continue; }
    balanceNeeds.set(key, true);
  }

  const needs = [...balanceNeeds.keys()];
  console.log(`  phase 2: ${needs.length} exact native checks · ${st.singletonsSkipped} single-call contracts skipped · ${st.nativeDeferred} deferred over cap`);
  const balCalls = [];
  for (const key of needs) {
    const [addr, b] = key.split(':');
    balCalls.push({ method: 'eth_getBalance', params: [addr, '0x' + Number(b).toString(16)] });
    balCalls.push({ method: 'eth_getBalance', params: [addr, '0x' + (Number(b) - 1).toString(16)] });
  }
  const balRes = await rpcMany(chain, balCalls, batch ? 25 : 1);
  const nativeIn = new Map();
  needs.forEach((key, i) => {
    const after = balRes[i * 2], before = balRes[i * 2 + 1];
    if (after == null || before == null) return;
    nativeIn.set(key, hexToBig(after) - hexToBig(before)); // delta; gas + value added back per-tx below
  });

  {
    // ── phase 3: classify
    for (const p of repeatable) {
      const key = `${p.sender}:${p.b}`;
      let nativeGain = null;
      if (p.soleSender && nativeIn.has(key)) {
        const gasCost = hexToBig(p.rc.gasUsed) * hexToBig(p.rc.effectiveGasPrice ?? p.tx.gasPrice ?? '0x0');
        // OP-stack chains deduct an L1 data fee that gasUsed×effectiveGasPrice does not include.
        // Leave it out and the sender looks poorer than they are, hiding real inflows.
        const l1Fee = hexToBig(p.rc.l1Fee ?? '0x0');
        nativeGain = nativeIn.get(key) + p.valueSent + gasCost + l1Fee;
        S(chain).nativeChecked++;
      } else {
        S(chain).nativeUnknown++;
      }

      const hasNative = nativeGain != null && nativeGain > 0n;
      const paidOut = p.anyTokenOut || (p.valueSent > 0n && !hasNative);
      if (paidOut) continue;                              // exchange of value, not a one-sided payout
      if (!p.tokenPayout && !hasNative) continue;         // nothing actually arrived

      S(chain).payoutShaped++;
      const k = `${p.tx.to.toLowerCase()}:${p.selector}`;
      const rec = payers.get(k) || {
        contract: p.tx.to.toLowerCase(), selector: p.selector, hits: 0,
        callers: new Set(), tokens: {}, native: 0n, nativeHits: 0,
        gas: [], sampleTx: p.rc.transactionHash, firstBlock: p.b, lastBlock: p.b,
        sampleInput: p.tx.input, sampleBlock: p.b,
      };
      rec.hits++;
      rec.callers.add(p.sender);
      rec.gas.push(Number(hexToBig(p.rc.gasUsed)));
      rec.firstBlock = Math.min(rec.firstBlock, p.b);
      rec.lastBlock = Math.max(rec.lastBlock, p.b);
      for (const [tok, amt] of Object.entries(p.net)) {
        rec.tokens[tok] = (rec.tokens[tok] ?? 0n) + amt;
        tokensSeen.add(tok);
      }
      if (hasNative) { rec.native += nativeGain; rec.nativeHits++; }
      payers.set(k, rec);
    }
  }

  console.log(`  phase 3: ${st.payoutShaped} payout-shaped events · ${payers.size} distinct payers`);
  // A ZERO IS A CLAIM ABOUT THE DETECTOR. If nothing was read, "no payers found" is a statement about
  // our RPC, not about the chain — and it must never be recorded as an observation.
  if (st.blocksScanned === 0) throw new Error(`${chain}: 0 of ${st.blocksAttempted} blocks readable — result is about the RPC, not the chain`);
  return { chain, head, payers, tokensSeen };
}

/* ───────────────────────────── enrich + rank ───────────────────────────── */
async function priceAndRank(chain, payers, tokensSeen) {
  const cfg = CHAINS[chain];
  await fetchLlama([...[...tokensSeen].map(t => tokenKey(chain, t)), cfg.nativeKey]);
  const nativePx = priceCache.get(cfg.nativeKey)?.price ?? null;
  const missingDec = await fillMissingDecimals(chain, [...tokensSeen]);

  // gas cost in USD needs a current gas price; one read, reused.
  const [gasPriceHex] = await rpcMany(chain, [{ method: 'eth_gasPrice', params: [] }]);
  const gasPrice = hexToBig(gasPriceHex || '0x0');

  const rows = [];
  for (const rec of payers.values()) {
    const opc = operatorClusters([...rec.callers]);
    let usd = 0, unpricedCount = 0, spotOnly = false, lowConfidence = false;
    const tokens = [];
    for (const [tok, amt] of Object.entries(rec.tokens)) {
      const p = priceCache.get(tokenKey(chain, tok));
      if (p) {
        const v = Number(formatUnits(amt, p.decimals)) * p.price;
        usd += v;
        const executable = EXECUTABLE_TOKENS.has(tok);
        if (!executable) spotOnly = true;
        if (p.confidence < 0.9) lowConfidence = true;
        tokens.push({ token: tok, symbol: p.symbol, raw: amt.toString(), decimals: p.decimals,
                      usd: +v.toFixed(6), priced: true, confidence: p.confidence, executable });
      } else {
        unpricedCount++;
        const dec = missingDec[tok] ?? null;
        tokens.push({
          token: tok, symbol: null, raw: amt.toString(), decimals: dec,
          amount: dec != null ? formatUnits(amt, dec) : null, usd: null, priced: false,
        });
      }
    }
    let nativeUsd = null;
    if (rec.native > 0n && nativePx != null) nativeUsd = Number(formatUnits(rec.native, 18)) * nativePx;
    const grossUsd = usd + (nativeUsd ?? 0);

    const avgGas = Math.round(rec.gas.reduce((a, b) => a + b, 0) / rec.gas.length);
    const gasUsd = nativePx != null ? Number(formatUnits(BigInt(avgGas) * gasPrice, 18)) * nativePx : null;

    rows.push({
      chain, contract: rec.contract, selector: rec.selector,
      hits: rec.hits, distinct_callers: rec.callers.size,
      // distinct_callers counts ADDRESSES and is an upper bound; this is the corrected count.
      distinct_operators: opc.operators,
      operator_clustering: opc.fleets.length ? opc : null,
      gross_usd: +grossUsd.toFixed(6),
      gross_usd_per_call: +(grossUsd / rec.hits).toFixed(6),
      gas_usd_per_call: gasUsd == null ? null : +gasUsd.toFixed(6),
      net_usd_per_call: gasUsd == null ? null : +((grossUsd / rec.hits) - gasUsd).toFixed(6),
      native_raw: rec.native.toString(), native_usd: nativeUsd == null ? null : +nativeUsd.toFixed(6),
      native_hits: rec.nativeHits,
      avg_gas: avgGas, tokens,
      fully_priced: unpricedCount === 0 && (rec.native === 0n || nativePx != null),
      unpriced_tokens: unpricedCount,
      // A single address collecting from a claim-shaped selector is almost certainly taking its own
      // principal back. Two independent signals have to agree before we call it principal-shaped.
      shape: (PRINCIPAL_SELECTORS.has(rec.selector) && rec.callers.size <= 2) ? 'principal' : 'bounty',
      // Native and canonical stables are money. Anything else is a quote we have not proven we can exit.
      spot_only: spotOnly, low_confidence_price: lowConfidence,
      executable_usd_per_call: +(((nativeUsd ?? 0) + tokens.filter(t => t.executable).reduce((a, t) => a + (t.usd || 0), 0)) / rec.hits).toFixed(6),
      first_block: rec.firstBlock, last_block: rec.lastBlock,
      sample_tx: rec.sampleTx, sample_input: rec.sampleInput, sample_block: rec.sampleBlock,
    });
  }

  // Rank on NET where we have it; rows we could not fully price are ranked separately rather than
  // being sorted to the bottom as if they were worth zero.
  const priced = rows.filter(r => r.fully_priced && r.net_usd_per_call != null && r.shape === 'bounty')
    .sort((a, b) => b.net_usd_per_call - a.net_usd_per_call);
  // ACTIONABLE ordering is applied after the probe runs (see rankActionable) — a $41k payout we can
  // never make is worth strictly less to us than a $0.001 one we can.
  const unpriced = rows.filter(r => !r.fully_priced && r.shape === 'bounty')
    .sort((a, b) => b.distinct_callers - a.distinct_callers || b.hits - a.hits);
  const principal = rows.filter(r => r.shape === 'principal')
    .sort((a, b) => (b.gross_usd || 0) - (a.gross_usd || 0));

  return { rows, priced, unpriced, principal, nativePx, gasPrice: gasPrice.toString() };
}

/* ── contract families: one verdict should predict its siblings (DOCTRINE §5) ── */
async function familyRollup(chain, rows) {
  const addrs = [...new Set(rows.map(r => r.contract))];
  const codes = await rpcMany(chain, addrs.map(a => ({ method: 'eth_getCode', params: [a, 'latest'] })));
  const fam = {};
  addrs.forEach((a, i) => {
    const code = codes[i];
    if (!code || code === '0x') { fam[a] = null; return; }
    fam[a] = keccak256(code).slice(0, 18); // short family id
  });
  const groups = {};
  for (const r of rows) {
    const f = fam[r.contract]; if (!f) continue;
    (groups[f] ||= { family: f, members: new Set(), hits: 0, callers: 0, gross_usd: 0 });
    groups[f].members.add(r.contract);
    groups[f].hits += r.hits;
    groups[f].callers += r.distinct_callers;
    groups[f].gross_usd += r.gross_usd || 0;
  }
  for (const r of rows) r.family = fam[r.contract];
  return Object.values(groups)
    .map(g => ({ family: g.family, contracts: g.members.size, hits: g.hits, callers: g.callers, gross_usd: +g.gross_usd.toFixed(6) }))
    .filter(g => g.contracts > 1 || g.hits > 1)
    .sort((a, b) => b.gross_usd - a.gross_usd || b.hits - a.hits);
}

/* ── callability: could ZERO have earned this, or only the operator we watched? ──
 *
 * eth_call is a READ. Nothing is signed, nothing is spent, no state changes — per DOCTRINE, the test
 * is a simulation, never capital.
 *
 * The first cut of this probe fired a BARE SELECTOR with no arguments, which reverts for essentially
 * every contract and so graded all 12 candidates identically. Useless. What actually discriminates is
 * replaying the OBSERVED CALLDATA from ZERO's address, at two heights:
 *
 *   THEN — the block just before the payout we watched. Would ZERO have won that exact race?
 *   NOW  — latest. Is there work available right this second?
 *
 * The pair separates three states that matter enormously and look identical from outside:
 *   OPEN       then ok, now ok      — the contract ACCEPTS this call from ZERO, then and now.
 *   KEEPER     then ok, now revert  — permissionless, but that opportunity is spent. This is the
 *                                     shape of every real keeper route: recheck when work appears.
 *   CLOSED     then revert          — the original caller held something we do not: a role, an
 *                                     allowance, a position. Not ours, and never will be.
 * Historical calls need archive state; where the node refuses, the row is marked NO-ARCHIVE rather
 * than being scored as a revert, because "the node would not answer" is not "the contract said no".
 *
 * ⚠️ CEILING, stated because the first version of this probe overstated it. This scores onto the
 * ladder sponsor-probe.mjs already defines — 0 FOUND · 1 REACHABLE · 2 ACCEPTED · 3 EXECUTED ·
 * 4 PROFITABLE — and it can never award better than **rung 2**. eth_call proves the call is accepted
 * from our address; it cannot show a balance change, so it cannot prove the call PAYS. Only a settled
 * transaction reaches rung 3, and only a measured balance increase reaches rung 4. Nothing this map
 * outputs may be reported as income. */
async function probeCallability(chain, rows, limit) {
  const targets = rows.slice(0, limit).filter(r => r.sample_input && r.sample_block);
  if (!targets.length) return;

  const { url } = await pickEndpoint(chain);
  const detailed = async (params) => {
    try {
      const j = await rawPost(url, { jsonrpc: '2.0', id: 1, method: 'eth_call', params }, 25000);
      if (j.error) return { ok: false, msg: String(j.error.message || '').slice(0, 90) };
      return { ok: true };
    } catch (e) { return { ok: false, msg: 'transport: ' + String(e.message || e).slice(0, 60) }; }
  };
  const isArchiveRefusal = (m = '') => /missing trie node|state.*not available|archive|older than|state is not available|header not found|pruned/i.test(m);

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const r = targets[cursor++];
      const tx = { from: ZERO_WALLET, to: r.contract, data: r.sample_input, value: '0x0' };
      const [then, now] = await Promise.all([
        detailed([tx, '0x' + (r.sample_block - 1).toString(16)]),
        detailed([tx, 'latest']),
      ]);
      if (!then.ok && isArchiveRefusal(then.msg)) {
        r.zero_callable = now.ok ? 'OPEN' : 'NO-ARCHIVE';
        r.rung = now.ok ? 2 : 1;
        r.callable_note = now.ok
          ? 'rung 2 ACCEPTED at head; historical replay unavailable on this node'
          : 'node refused historical state and it reverts at head — undecided, not a no';
      } else if (then.ok && now.ok) {
        r.zero_callable = 'OPEN';
        r.rung = 2;
        r.callable_note = 'rung 2 ACCEPTED — the contract accepts this call FROM ZERO, at the observed block and at head. Not proof it pays: eth_call cannot show the balance change.';
      } else if (then.ok && !now.ok) {
        r.zero_callable = 'KEEPER';
        r.rung = 2;
        r.callable_note = 'rung 2 ACCEPTED then, reverts now — the classic keeper shape: permissionless for ZERO, that unit of work already taken. Recheck when fresh work appears.';
      } else {
        r.zero_callable = 'CLOSED';
        r.rung = 1;
        r.callable_note = 'reverts from ZERO even at the observed block: ' + (then.msg || 'no reason given');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RPC_CONCURRENCY, targets.length) }, worker));
}

/* -- DOES IT ACTUALLY PAY *US*? The gate that turns acceptance into money. --
 *
 * `eth_call` not reverting proves only that a contract ACCEPTS the call from ZERO. It says nothing
 * about who gets paid, and the first run of this map proved why that distinction is the whole game:
 * its two best rows graded OPEN at $411.48 and $1.19 per call, and when simulated properly BOTH paid
 * ZERO exactly nothing. One was a signed-payload relay whose proceeds are bound into the payload; the
 * other was claim(1308) -- a claim on somebody else's position id. Shipping those as routes would
 * have had ZERO burning gas for $0.00, which is strictly worse than having no route.
 *
 * eth_simulateV1 with traceTransfers closes it: run the call FROM ZERO and read the value that
 * actually moves TO ZERO, native and ERC-20 alike. Measured, keyless, free, and still only a
 * simulation -- rung 2 on the sponsor-probe.mjs ladder, never rung 4. A settled transaction is the
 * only thing that may ever be called income.
 *
 * The balance override exists so gas can never be the reason a simulation fails; validation:false
 * keeps the node from enforcing balance/nonce rules we are deliberately stepping around. */
const SIM_BALANCE = '0x21e19e0c9bab2400000'; // 10,000 native units -- gas must never be the blocker
const NATIVE_PSEUDO = /^0x0{40}$/;
async function simulatePayout(chain, rows, nativePx) {
  const { url } = await pickEndpoint(chain);
  const targets = rows.filter(r => r.sample_input);
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const r = targets[cursor++];
      let res;
      try {
        res = await rawPost(url, {
          jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{
            blockStateCalls: [{
              stateOverrides: { [ZERO_WALLET]: { balance: SIM_BALANCE } },
              calls: [{ from: ZERO_WALLET, to: r.contract, data: r.sample_input, value: '0x0' }],
            }],
            traceTransfers: true, validation: false,
          }, 'latest'],
        }, 30000);
      } catch (e) { r.sim = 'unavailable'; r.sim_note = String(e.message || e).slice(0, 70); continue; }

      if (res && res.error) { r.sim = 'unavailable'; r.sim_note = String(res.error.message || '').slice(0, 70); continue; }
      const call = res && res.result && res.result[0] && res.result[0].calls && res.result[0].calls[0];
      if (!call) { r.sim = 'unavailable'; r.sim_note = 'no call result'; continue; }
      if (call.status !== '0x1') { r.sim = 'reverts'; r.simulated_payout_usd = 0; continue; }

      // Sum everything that moved TO ZERO. traceTransfers emits native movement as a synthetic
      // Transfer log from the zero address, so both kinds are read the same way.
      let usd = 0; const got = [];
      for (const log of call.logs || []) {
        if ((log.topics && log.topics[0] || '').toLowerCase() !== TRANSFER) continue;
        if ((log.topics || []).length !== 3) continue; // 4 topics = NFT
        if (topicAddr(log.topics[2]) !== ZERO_WALLET.toLowerCase()) continue;
        const amt = hexToBig((log.data || '0x').slice(0, 66));
        if (amt <= 0n) continue;
        const addr = log.address.toLowerCase();
        if (NATIVE_PSEUDO.test(addr)) {
          if (nativePx != null) {
            const v = Number(formatUnits(amt, 18)) * nativePx;
            usd += v; got.push({ token: 'native', usd: +v.toFixed(6) });
          }
        } else {
          const px = priceCache.get(tokenKey(chain, addr));
          if (px) {
            const v = Number(formatUnits(amt, px.decimals)) * px.price;
            usd += v; got.push({ token: addr, symbol: px.symbol, usd: +v.toFixed(6) });
          } else {
            got.push({ token: addr, raw: amt.toString(), usd: null, priced: false });
          }
        }
      }
      r.simulated_payout_usd = +usd.toFixed(6);
      r.simulated_gas = Number(hexToBig(call.gasUsed || '0x0'));
      r.simulated_receipts = got;
      /* PAYS IS NOT PROFITS. The first two rows that ever cleared the payout gate paid ZERO $0.00031
       * and $0.000666 in VELO while costing ~$0.002 of gas each -- real money moving to us, and a
       * net loss every time. A route that pays less than it costs is a slow way to spend the wallet,
       * so the economics decide the grade, not the payout. */
      r.simulated_net_usd = (r.gas_usd_per_call == null) ? null : +(usd - r.gas_usd_per_call).toFixed(6);
      r.sim = usd > 0
        ? ((r.simulated_net_usd == null || r.simulated_net_usd > 0) ? 'PAYS' : 'PAYS-BUT-LOSES')
        : 'NO-PAY';
      r.sim_note = usd > 0
        ? (r.sim === 'PAYS'
            ? 'simulation moves $' + usd.toFixed(6) + ' to ZERO, net $' + String(r.simulated_net_usd) + ' after gas (rung 2 -- simulated, not settled)'
            : 'simulation moves $' + usd.toFixed(6) + ' to ZERO but gas costs $' + String(r.gas_usd_per_call) + ' -- a net LOSS of $' + String(Math.abs(r.simulated_net_usd || 0)) + ' per call')
        : 'call succeeds from ZERO but nothing moves to ZERO -- the payout is bound to someone else';
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
}


/* ── NAME THE THRESHOLD THAT WOULD MAKE IT POSSIBLE ──────────────────────────────────────────────
 *
 * Global rules §7: "'Impossible' is a measurement, not a conclusion. When something looks capped,
 * enumerate where else it exists before accepting the cap... Is the cost per unit or per BATCH?
 * Name the threshold that would make it possible and aim at it."
 *
 * A row that pays $0.0003 against $0.002 of gas reads as a dead end. It is not obviously one, because
 * the two numbers have DIFFERENT DENOMINATORS: a bounty is earned per unit of work, while gas is
 * charged per TRANSACTION. Batch enough units into one transaction and the per-transaction part
 * amortises away.
 *
 * But only that part, and this is the trap worth writing down: batching saves the **21,000 intrinsic
 * gas** and nothing else. Execution gas is spent per call however you bundle it. So the honest test
 * is not "payout vs gas" — it is **payout vs EXECUTION gas**:
 *
 *   net(N) = N·payout − (INTRINSIC + N·execGas)·gasPrice·nativeUsd
 *
 *   · payout > execGasCost  → profitable for N ≥ ceil(intrinsicCost / (payout − execGasCost)).
 *                             That N is the threshold. It is a build target, not a hope.
 *   · payout ≤ execGasCost  → NO batch size ever helps. That is a real cap, measured, and the only
 *                             remaining lever is someone else paying the gas.
 *
 * And that last lever is real for us: ZERO holds free relay capacity and there are live public
 * paymasters. With gas sponsored the comparison collapses to `payout > 0`, so `sponsored_net_usd`
 * is reported for every row — it is what the route is worth on a rail we already own. */
const INTRINSIC_GAS = 21000n;

function addThresholds(rows, gasPriceWei, nativePx) {
  if (nativePx == null || !gasPriceWei) return;
  const weiToUsd = (wei) => Number(formatUnits(wei, 18)) * nativePx;
  for (const r of rows) {
    const payout = r.simulated_payout_usd;
    if (typeof payout !== 'number') continue;

    // Execution gas from the simulation where we have it; the receipt average is a fallback and
    // includes the intrinsic, so subtract it rather than quietly overstating the per-unit cost.
    const execGas = r.simulated_gas != null
      ? BigInt(Math.max(0, Math.round(r.simulated_gas)))
      : BigInt(Math.max(0, Math.round((r.avg_gas || 0)))) - INTRINSIC_GAS;
    if (execGas <= 0n) continue;

    const execCost = weiToUsd(execGas * gasPriceWei);
    const intrinsicCost = weiToUsd(INTRINSIC_GAS * gasPriceWei);

    r.exec_gas = Number(execGas);
    r.exec_gas_usd = +execCost.toFixed(8);
    r.sponsored_net_usd = +payout.toFixed(8);          // someone else pays the gas → payout is the profit
    r.margin_per_unit_usd = +(payout - execCost).toFixed(8);

    if (payout > execCost) {
      const n = Math.ceil(intrinsicCost / (payout - execCost));
      r.batch_breakeven_n = Math.max(1, n);
      r.threshold_note = `profitable at ${Math.max(1, n)} per transaction — each unit clears execution gas by $${(payout - execCost).toFixed(8)}`;
    } else {
      r.batch_breakeven_n = null;
      r.threshold_note = `no batch size helps: one unit costs $${execCost.toFixed(8)} of EXECUTION gas and pays $${payout.toFixed(8)}. `
        + `Sponsored gas is the only remaining lever, worth $${payout.toFixed(8)}/call on a free rail.`;
    }
  }
}

/* -- OPERATORS, NOT ADDRESSES. The correction that saved a build. ------------------------------
 *
 * `distinct_callers` was this map's core permissionless signal: many callers => anyone may call =>
 * we may call. On 2026-08-21 that signal was measured wrong in the most expensive direction.
 *
 * Gnosis ERC-4337 bundling looked like a textbook open market: 52 distinct callers, flat 2.2-2.6%
 * each, HHI 201 (under 1500 reads "competitive"). Whole-pie arithmetic came out at 10.7x break-even
 * and it was one step from becoming a build.
 *
 * Then: 48 of those 52 addresses begin `0x4337` -- the ERC-4337 vanity prefix, ground out on purpose.
 * Probability for one address is 16^-4 = 1.53e-5; for 48 of them, ~6.4e-232. It is ONE operator
 * round-robining a wallet pool for nonce parallelism, carrying 96.3% of volume. The genuinely
 * independent remainder was 3.7% -- 0.4x break-even, i.e. dead.
 *
 * THE TRAP, written down so it is never re-entered: **splitting one operator across more addresses
 * makes every concentration metric look MORE competitive.** HHI computed over addresses cannot see
 * address-splitting, and address-splitting is the cheapest thing an on-chain operator can do. A crowd
 * of addresses is evidence of nothing until you have counted operators.
 *
 * Every distinct_callers figure this map has ever produced is therefore an UPPER BOUND on real
 * competition, and rows now carry the corrected count beside it. */
const VANITY_PREFIX_LEN = 4;   // hex chars after 0x; 16^4 = 65,536:1 against by chance
const FLEET_MIN_MEMBERS = 3;

function operatorClusters(addresses) {
  const addrs = [...new Set((addresses || []).map((a) => String(a).toLowerCase()))];
  const byPrefix = new Map();
  for (const a of addrs) {
    const pre = a.slice(2, 2 + VANITY_PREFIX_LEN);
    if (!/^[0-9a-f]+$/.test(pre) || pre.length < VANITY_PREFIX_LEN) continue;
    if (!byPrefix.has(pre)) byPrefix.set(pre, []);
    byPrefix.get(pre).push(a);
  }
  const fleets = [];
  for (const [pre, members] of byPrefix) {
    if (members.length < FLEET_MIN_MEMBERS) continue;
    const oddsAgainst = Math.pow(16, VANITY_PREFIX_LEN * (members.length - 1));
    fleets.push({ prefix: '0x' + pre, members: members.length, addresses: members.slice(0, 8), odds_against: oddsAgainst });
  }
  const clustered = fleets.reduce((a, f) => a + f.members, 0);
  return {
    addresses: addrs.length,
    operators: addrs.length - clustered + fleets.length,
    fleets,
    note: fleets.length
      ? clustered + ' of ' + addrs.length + ' addresses share ' + fleets.length + ' vanity prefix(es) - a controlled fleet, not competitors'
      : 'no vanity clustering detected (does not rule out common funding or timing correlation)',
  };
}

if (argv.includes('--test-clusters')) selfTestClusters();

/* Re-order a probed list so what ZERO can actually do comes first. Rank, not filter: CLOSED rows stay
 * in the map because tomorrow's role change or tomorrow's clone makes them live again. */
const CALLABLE_RANK = { OPEN: 0, KEEPER: 1, 'NO-ARCHIVE': 2, undefined: 3, CLOSED: 4 };
const SIM_RANK = { PAYS: 0, unavailable: 1, undefined: 1, 'PAYS-BUT-LOSES': 2, 'NO-PAY': 3, reverts: 4 };
function rankActionable(rows) {
  return [...rows].sort((a, b) => {
    // A measured payout to US outranks every other signal, including a bigger observed payout.
    const sa = SIM_RANK[a.sim] ?? 1, sb = SIM_RANK[b.sim] ?? 1;
    if (sa !== sb) return sa - sb;
    if ((a.simulated_payout_usd ?? 0) !== (b.simulated_payout_usd ?? 0)) {
      return (b.simulated_payout_usd ?? 0) - (a.simulated_payout_usd ?? 0);
    }
    const ra = CALLABLE_RANK[a.zero_callable] ?? 3, rb = CALLABLE_RANK[b.zero_callable] ?? 3;
    if (ra !== rb) return ra - rb;
    // Money we could actually hold outranks a quote in a thin token, however large the quote.
    if (!!a.spot_only !== !!b.spot_only) return a.spot_only ? 1 : -1;
    const ea = a.executable_usd_per_call ?? 0, eb = b.executable_usd_per_call ?? 0;
    if (ea !== eb) return eb - ea;
    return (b.net_usd_per_call ?? -Infinity) - (a.net_usd_per_call ?? -Infinity);
  });
}

/* ───────────────────────────── durable merged map ───────────────────────────── */
function mergeIntoMap(all) {
  const file = path.join(STATE, 'wallet-map.json');
  let prior = { version: 2, createdAt: new Date().toISOString(), runs: [], payers: {} };
  if (existsSync(file)) {
    try { prior = JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt: start clean, keep a backup */
      try { writeFileSync(file + '.corrupt-' + Date.now(), readFileSync(file)); } catch {}
    }
  }
  prior.payers ||= {}; prior.runs ||= [];
  const now = new Date().toISOString();

  let added = 0, updated = 0;
  for (const chainResult of all) {
    for (const r of chainResult.ranked.rows) {
      const key = `${r.chain}:${r.contract}:${r.selector}`;
      const ex = prior.payers[key];
      if (!ex) {
        prior.payers[key] = {
          ...r, first_seen: now, last_seen: now, observations: 1,
          cumulative_hits: r.hits, best_net_usd_per_call: r.net_usd_per_call,
        };
        added++;
      } else {
        ex.last_seen = now;
        ex.observations = (ex.observations || 1) + 1;
        ex.cumulative_hits = (ex.cumulative_hits || 0) + r.hits;
        ex.distinct_callers = Math.max(ex.distinct_callers || 0, r.distinct_callers);
        if (r.net_usd_per_call != null && (ex.best_net_usd_per_call == null || r.net_usd_per_call > ex.best_net_usd_per_call)) {
          ex.best_net_usd_per_call = r.net_usd_per_call;
        }
        // refresh the live view but never lose history
        for (const k of ['gross_usd', 'gross_usd_per_call', 'net_usd_per_call', 'gas_usd_per_call',
                         'tokens', 'native_usd', 'avg_gas', 'sample_tx', 'family', 'fully_priced',
                         'zero_callable', 'callable_note', 'shape', 'sample_block',
                         'rung', 'spot_only', 'low_confidence_price', 'executable_usd_per_call',
                         'distinct_operators', 'operator_clustering',
                         'sim', 'simulated_payout_usd', 'sim_note', 'simulated_receipts',
                         'simulated_net_usd', 'exec_gas_usd', 'margin_per_unit_usd',
                         'batch_breakeven_n', 'sponsored_net_usd', 'threshold_note']) {
          if (r[k] !== undefined) ex[k] = r[k];
        }
        updated++;
      }
    }
  }
  prior.runs.push({
    at: now,
    chains: all.map(a => ({ chain: a.chain, ...stats[a.chain], head: a.head, payers: a.ranked.rows.length })),
    added, updated,
  });
  if (prior.runs.length > 200) prior.runs = prior.runs.slice(-200);
  prior.updatedAt = now;
  prior.totalPayers = Object.keys(prior.payers).length;

  if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
  writeFileSync(file, JSON.stringify(prior, null, 1));
  return { file, added, updated, total: prior.totalPayers };
}

/* ───────────────────────────── main ───────────────────────────── */
console.log('wallet-map · the empirical map of who pays their callers');
console.log('controls first — the instrument must rediscover a known specimen before its output counts.\n');

const controls = await runControls(CHAIN_LIST);
for (const c of controls) console.log(`  ${c.inconclusive ? '????' : (c.pass ? 'PASS' : 'FAIL')}  ${c.control} — ${c.detail}`);
const failed = controls.filter(c => !c.pass);
const inconclusive = controls.filter(c => c.inconclusive);
if (inconclusive.length) {
  console.log(`\n⚠ ${inconclusive.length} control(s) INCONCLUSIVE — they did not run, which is not the same as failing. `
    + 'Proceeding, and the state is recorded in the snapshot so no downstream reader can mistake an unrun control for a passed one.');
}
if (failed.length) {
  console.error(`\n${failed.length} control(s) FAILED. Writing nothing.`);
  console.error('A map that cannot price a dollar cannot be believed when it reports a zero.');
  process.exit(1);
}
console.log('\nall controls passed.');
if (SELFTEST_ONLY) { console.log('--selftest: stopping before the scan, nothing written.'); process.exit(0); }

const all = [];
for (const chain of CHAIN_LIST) {
  try {
    const scan = await scanChain(chain, NBLOCKS);
    const ranked = await priceAndRank(chain, scan.payers, scan.tokensSeen);
    ranked.families = await familyRollup(chain, ranked.rows);
    if (DO_PROBE) {
      await probeCallability(chain, ranked.priced, PROBE_TOP);
      await probeCallability(chain, ranked.unpriced, Math.min(PROBE_TOP, 10));
      const accepted = ranked.priced.filter(r => r.zero_callable && r.zero_callable !== 'CLOSED');
      await simulatePayout(chain, accepted, ranked.nativePx);
      // Only rows where the simulation actually moves money to ZERO are actionable. NO-PAY rows stay
      // in the durable map -- they are a real finding, just not a route.
      addThresholds(accepted, BigInt(ranked.gasPrice || '0'), ranked.nativePx);
      ranked.actionable = rankActionable(accepted.filter(r => r.sim === 'PAYS' || r.sim === 'unavailable'));
      ranked.noPay = accepted.filter(r => r.sim === 'NO-PAY' || r.sim === 'reverts');
      ranked.losers = accepted.filter(r => r.sim === 'PAYS-BUT-LOSES');
    } else { ranked.actionable = []; }
    all.push({ chain, head: scan.head, ranked });

    const st = S(chain);
    console.log(`\n[${chain}] blocks ${st.blocksScanned}/${st.blocksAttempted} scanned (${st.blocksFailed} failed, ${st.rpcErrors} rpc errors)`);
    console.log(`[${chain}] ${st.txsExamined} txs · ${st.txsSkippedTrade} trades skipped · ${st.payoutShaped} payout-shaped · ${ranked.rows.length} distinct (contract,selector) payers`);
    console.log(`[${chain}] native: ${st.nativeChecked} exact, ${st.nativeUnknown} unknown (multi-tx senders) · ${st.nftLogsIgnored} NFT logs ignored`);
    console.log(`[${chain}] priced rows ${ranked.priced.length} · unpriced rows ${ranked.unpriced.length} · native $${ranked.nativePx ?? '?'}`);

    const show = (r) => ` ${String(r.net_usd_per_call ?? '—').padStart(10)} net/call · ${String(r.gross_usd_per_call).padStart(10)} gross · ${r.hits}h ${r.distinct_callers}c · ${r.contract} ${r.selector}${r.zero_callable ? ' · ' + r.zero_callable : ''}`;
    if (ranked.priced.length) {
      console.log(`\n=== [${chain}] TOP BY NET USD PER CALL (gas subtracted) ===`);
      ranked.priced.slice(0, 15).forEach(r => console.log(show(r)));
    }
    if (ranked.actionable && ranked.actionable.length) {
      console.log(`
=== [${chain}] ⭐ ACTIONABLE FOR ZERO (simulated from our own address) ===`);
      console.log(' (rung 2 -- SIMULATED payout to ZERO. Not settled money; only a real tx reaches rung 3.)');
      ranked.actionable.slice(0, 12).forEach(r => console.log(
        ` ${String(r.sim).padEnd(11)} sim-pays $${String(r.simulated_payout_usd ?? '?').padStart(11)} · observed $${String(r.net_usd_per_call).padStart(10)} · ${r.hits}h ${r.distinct_callers}c · ${r.contract} ${r.selector}${r.spot_only ? ' · SPOT-ONLY' : ''}`));
    } else if (DO_PROBE) {
      console.log(`
=== [${chain}] ⭐ ACTIONABLE FOR ZERO: none in this window - no probed payer both accepts a call from ZERO and moves value to it ===`);
    }
    if (ranked.losers && ranked.losers.length) {
      console.log(`\n=== [${chain}] PAYS US, BUT COSTS MORE THAN IT PAYS (${ranked.losers.length}) ===`);
      ranked.losers.slice(0, 8).forEach(r => {
        console.log(` pays $${String(r.simulated_payout_usd).padStart(10)} · exec-gas $${String(r.exec_gas_usd ?? '?').padStart(10)} · ${r.contract} ${r.selector}`);
        if (r.threshold_note) console.log(`      → ${r.threshold_note}`);
      });
      const batchable = ranked.losers.filter(r => r.batch_breakeven_n);
      if (batchable.length) {
        console.log(`\n  ⭐ ${batchable.length} of these FLIP POSITIVE when batched. Thresholds: ` +
          batchable.slice(0, 6).map(r => `${r.selector}×${r.batch_breakeven_n}`).join(', '));
      }
      const sponsorable = ranked.losers.filter(r => (r.sponsored_net_usd || 0) > 0);
      if (sponsorable.length) {
        const tot = sponsorable.reduce((a, r) => a + r.sponsored_net_usd, 0);
        console.log(`  ⭐ on SPONSORED gas all ${sponsorable.length} are profitable — $${tot.toFixed(8)} per full pass of them.`);
      }
    }
    if (ranked.noPay && ranked.noPay.length) {
      console.log(`\n=== [${chain}] ACCEPTED BUT PAYS US NOTHING (${ranked.noPay.length}) - the trap this gate exists to catch ===`);
      ranked.noPay.slice(0, 6).forEach(r => console.log(
        ` observed $${String(r.net_usd_per_call).padStart(10)}/call - simulation moves $0 to ZERO - ${r.contract} ${r.selector}`));
    }
    const open = ranked.rows.filter(r => r.distinct_callers >= 2);
    console.log(`\n=== [${chain}] PERMISSIONLESS-LOOKING (2+ distinct callers) : ${open.length} ===`);
    /* Print OPERATORS next to addresses. This line is where the wrong read gets made: on gnosis it
     * said "51 callers", which is true and means nothing, because 48 of them were one operator's
     * vanity fleet. Never show the address count on its own again. */
    open.sort((a, b) => b.distinct_callers - a.distinct_callers)
      .slice(0, 15).forEach(r => {
        const oc = r.operator_clustering;
        const who = oc
          ? `${String(oc.addresses).padStart(3)} addrs -> ${String(oc.operators).padStart(2)} OPERATORS`
          : `${String(r.distinct_callers).padStart(3)} callers            `;
        console.log(` ${who} · ${r.hits} hits · ${r.contract} ${r.selector} · ${r.fully_priced ? '$' + r.gross_usd_per_call + '/call' : 'UNPRICED(' + r.unpriced_tokens + ')'}`);
        if (oc) console.log(`      !! ${oc.note} (prefix ${oc.fleets[0].prefix}, ~${oc.fleets[0].odds_against.toExponential(1)} against by chance)`);
      });
    if (ranked.unpriced.length) {
      console.log(`\n=== [${chain}] UNPRICED — real payouts we could not value (NOT zero) ===`);
      ranked.unpriced.slice(0, 10).forEach(r => console.log(` ${r.hits}h ${r.distinct_callers}c · ${r.contract} ${r.selector} · ` +
        r.tokens.filter(t => !t.priced).map(t => `${t.amount ?? t.raw} of ${t.token.slice(0, 10)}…`).join(', ')));
    }
    if (ranked.principal && ranked.principal.length) {
      console.log(`
=== [${chain}] PRINCIPAL-SHAPED (own money back, held out of ranking) : ${ranked.principal.length} ===`);
      ranked.principal.slice(0, 6).forEach(r => console.log(` ${r.contract} ${r.selector} · ${r.hits}h ${r.distinct_callers}c · ${r.fully_priced ? '$' + r.gross_usd : 'unpriced'}`));
    }
    if (ranked.families.length) {
      console.log(`\n=== [${chain}] CONTRACT FAMILIES (one verdict predicts siblings) ===`);
      ranked.families.slice(0, 8).forEach(f => console.log(` ${f.family} · ${f.contracts} contracts · ${f.hits} hits · ${f.callers} callers · $${f.gross_usd}`));
    }
  } catch (e) {
    console.error(`[${chain}] SCAN FAILED: ${String(e.message || e)}`);
    all.push({ chain, head: null, ranked: { rows: [], priced: [], unpriced: [], families: [] }, error: String(e.message || e) });
  }
}

// If every chain failed, write nothing at all — same reasoning as a failed control.
if (all.length && all.every(a => a.error)) {
  console.error('\nEVERY chain failed to scan. Writing nothing — this run measured our RPC, not the chains.');
  for (const a of all) console.error(`  ${a.chain}: ${a.error}`);
  process.exit(1);
}
const merged = mergeIntoMap(all);
const snapshot = {
  version: 2, probedAt: new Date().toISOString(), blocksRequested: NBLOCKS,
  controls, chains: all.map(a => ({
    chain: a.chain, head: a.head, error: a.error ?? null, stats: stats[a.chain] ?? null,
    nativePrice: a.ranked.nativePx ?? null,
    payers: a.ranked.rows.length,
    permissionless: a.ranked.rows.filter(r => r.distinct_callers >= 2).length,
    unpriced: a.ranked.unpriced.length,
    actionable: (a.ranked.actionable || []).slice(0, 40),
    noPay: (a.ranked.noPay || []).slice(0, 20),
    losers: (a.ranked.losers || []).slice(0, 20),
    top: a.ranked.priced.slice(0, 40),
    openPayers: a.ranked.rows.filter(r => r.distinct_callers >= 2).slice(0, 40),
    unpricedRows: a.ranked.unpriced.slice(0, 40),
    families: (a.ranked.families || []).slice(0, 20),
  })),
};
writeFileSync(path.join(HERE, 'wallet-map-result.json'), JSON.stringify(snapshot, null, 1));

/* A small, clean file for the agent to consume — only rows the contract ACCEPTED from ZERO, with the
 * calldata needed to try them and the ceiling stated inline so nothing downstream can read a rung-2
 * row as income. Push to the Worker's memory with `node sync.mjs push` when it is worth bestowing. */
const actionable = all.flatMap(a => (a.ranked.actionable || []).map(r => ({
  chain: r.chain, contract: r.contract, selector: r.selector, calldata: r.sample_input,
  grade: r.zero_callable, rung: r.rung ?? 2, sim: r.sim,
  simulated_payout_usd: r.simulated_payout_usd, simulated_receipts: r.simulated_receipts, sim_note: r.sim_note,
  executable_usd_per_call: r.executable_usd_per_call, quoted_usd_per_call: r.net_usd_per_call,
  gas_usd_per_call: r.gas_usd_per_call, spot_only: !!r.spot_only,
  distinct_callers: r.distinct_callers, hits: r.hits, family: r.family, sample_tx: r.sample_tx,
})));
writeFileSync(path.join(STATE, 'wallet-map-actionable.json'), JSON.stringify({
  generatedAt: snapshot.probedAt,
  ceiling: 'rung 2 ACCEPTED — eth_call proves the call is taken from ZERO, NEVER that it pays. '
         + 'Rung 3 needs a settled tx; rung 4 needs a measured balance increase. Do not report as income.',
  spot_warning: 'spot_only rows are quoted in tokens we have not proven we can exit at that price. '
              + 'executable_usd_per_call counts only native, canonical WETH and major stables.',
  count: actionable.length, rows: actionable,
}, null, 1));

// Backwards compatibility: scripts/brain-corpus.json reads freemoney-map-result.json by name.
// Keep that surface alive rather than orphaning a consumer, but write the corrected numbers.
const legacyChain = all.find(a => a.ranked.rows.length) || all[0];
if (legacyChain) {
  writeFileSync(path.join(HERE, 'freemoney-map-result.json'), JSON.stringify({
    probedAt: snapshot.probedAt, chain: legacyChain.chain, blocksScanned: stats[legacyChain.chain]?.blocksScanned ?? 0,
    fromBlock: legacyChain.head, txsExamined: stats[legacyChain.chain]?.txsExamined ?? 0,
    payoutShapedEvents: stats[legacyChain.chain]?.payoutShaped ?? 0,
    distinctPayers: legacyChain.ranked.rows.length,
    openPayers: legacyChain.ranked.rows.filter(r => r.distinct_callers >= 2).length,
    richPayers: legacyChain.ranked.rows.filter(r => (r.net_usd_per_call ?? 0) >= 0.01).length,
    supersededBy: 'scripts/wallet-map.mjs — v1 priced arbitrum at $0 for every row; see the header of that file',
    top: legacyChain.ranked.priced.slice(0, 60),
    permissionless: legacyChain.ranked.rows.filter(r => r.distinct_callers >= 2).slice(0, 60),
  }, null, 2));
}

console.log(`\n───────────────────────────────────────────────`);
console.log(`accumulated map: ${merged.total} payers total (+${merged.added} new, ${merged.updated} refreshed)`);
console.log(`  ${merged.file}`);
console.log(`  ${path.join(HERE, 'wallet-map-result.json')} (this run)`);
