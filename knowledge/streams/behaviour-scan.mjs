// behaviour-scan.mjs — find contracts that pay people, by what they DO, not by what they are called
// or by who has already been paid by them. READ-ONLY: eth_getLogs / eth_getBlockReceipts / eth_getCode.
// Zero dependencies (the Transfer topic is a constant, so not even ethers is needed).
//
// ---------------------------------------------------------------------------------------------
// WHAT IT DOES
// ---------------------------------------------------------------------------------------------
// Reads raw ERC-20/721 `Transfer` events straight off the chain over a recent block window and ranks
// contracts by a footprint a giveaway cannot hide: ONE SOURCE, MANY DISTINCT RECIPIENTS, REPEATEDLY.
// Two footprints, both bought with the same logs:
//
//   MINT        Transfer(from = 0x0, to = X) — X got tokens out of thin air. Many distinct X against
//               one token in a short window is an open mint, which is a faucet whatever it is named.
//   DISTRIBUTE  Transfer(from = C, to = X) where C HAS CODE — a contract handing its balance out.
//               (The `has code` clause is load-bearing. An EOA airdropping by hand is not something
//               anyone else can call, and without the check the list fills with human senders.)
//
// It also counts, per source, how many recipients were paid MORE THAN ONCE. That number is the cheap
// version of the only question that matters for income: is this repeatable, or was it a one-off?
//
// ---------------------------------------------------------------------------------------------
// WHY THE API-BOUND DISCOVERY LAYER IS STRUCTURALLY BLIND TO THESE
// ---------------------------------------------------------------------------------------------
// ZERO's discovery has two existing routes, and each has a precondition this one does not:
//
//   1. `https://api.beefy.finance/vaults` — can only ever return BEEFY vaults. Any payer that is not
//      in Beefy's product catalogue does not exist as far as that route is concerned. It is a
//      catalogue lookup, not a search.
//   2. `discover.mjs :: blindSeed()` — genuinely mechanism-blind and much better, but it finds paid
//      CALLERS first ("an EOA sent a transaction and an ERC-20 came back, and it sent nothing in")
//      and then walks backwards to the payers. That requires SOMEBODY TO HAVE ALREADY BEEN PAID.
//
// This module has neither precondition. It looks at the payer directly, so it surfaces:
//   · contracts that pay but that no keeper has ever called — invisible to (2) by construction,
//     and those are exactly the ones still holding an unclaimed balance;
//   · the MINT class, which has NO caller-side footprint at all — the tokens come from address(0),
//     so there is no prior payout for a keeper-first search to walk backwards from.
//
// MEASURED 2026-08-01 (the run this module was extracted from): on base, 400 blocks / 92,271 Transfer
// logs produced 715 candidates (36 open-mint tokens, 679 distributor contracts). Probing those found
// three base contracts paying real WETH to an arbitrary caller via `harvest(address)`, accruing
// continuously — none of which came from the Beefy vault list.
// ⚠️ Honest limit on that result: those were Beefy STRATEGY proxies, i.e. the same family, reached by
// a different road. This module widens the ROAD; it is not by itself proof of a new mechanism family.
//
// ---------------------------------------------------------------------------------------------
// MEASURED ENVIRONMENT LIMITS (all three hit for real, all three measured, not assumed)
// ---------------------------------------------------------------------------------------------
// 1. POLYGON REFUSES ADDRESS-AGNOSTIC eth_getLogs — and the refusal is INCONSISTENT.
//      `polygon-bor-rpc.publicnode.com` → "Please specify an address in your request or, to remove
//      restrictions, order a dedicated full node". Measured refusing a topic-only filter at spans of
//      10, 3 and even 1 block — and then, minutes later in the same session, serving a single block
//      fine. So the honest claim is "unreliable there", NOT "impossible there".
//    ⇒ Either way it is a limit of ONE METHOD, not of the chain. The relation needed is "Transfer
//      events in a block range"; `eth_getLogs` is one product for it and `eth_getBlockReceipts` is
//      another, and the second has never been refused on any chain measured. VERIFIED the two agree
//      exactly — base block 49383882 returned 164 Transfer logs by both routes — and a polygon
//      end-to-end scan reads its window via receipts (1,496 transfers / 4 blocks).
//      Cost of the fallback: one RPC call per block instead of one per `chunk` blocks.
//    ⇒ Because the refusal is inconsistent, the transport is not chosen once and trusted. Each chunk
//      falls back on its own, and a primary that fails twice is abandoned for the rest of the run.
//      This was NOT foresight — the self-test caught base passing the probe and then refusing every
//      subsequent chunk, which returned 0 transfers and looked exactly like a chain with nothing on
//      it. Hence `trustworthy` on the result: a consumer must never have to infer whether an empty
//      candidate list means "nothing was there" or "nothing was read".
//
// 2. NO ARCHIVE STATE on the free RPCs.
//      Any historical block → "Archive requests require a personal token." Consequence for a caller:
//      a candidate that stops paying CANNOT be distinguished from a measurement that was wrong. This
//      module therefore only ever reads a RECENT window and stamps `headBlock` on its output so a
//      consumer knows exactly what was and was not seen.
//
// 3. eth_getLogs IS CAPPED AT A 10,000-BLOCK RANGE.
//      `publicnode` → "eth_getLogs is limited to a 10,000 range". THE DANGEROUS PART: going over the
//      cap returns an ERROR, NOT LESS DATA. Any `catch {}` around it silently converts "I asked the
//      wrong question" into "this contract has no payout history", which a caller then reads as "not
//      repeatable". `MAX_LOG_RANGE` below is clamped so the question is never asked illegally, and
//      failed chunks are COUNTED and reported in `chunksFailed` rather than swallowed.
//
// ---------------------------------------------------------------------------------------------
// RUNNABLE EXAMPLE
// ---------------------------------------------------------------------------------------------
//   import { behaviourScan } from './knowledge/streams/behaviour-scan.mjs';
//
//   // rpcRaw is the same shape discover.mjs already injects: (method, params) => result | null
//   const rpcRaw = (method, params) => fetch('https://base-rpc.publicnode.com', {
//     method: 'POST', headers: { 'content-type': 'application/json' },
//     body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
//   }).then(r => r.json()).then(j => (j.error ? null : j.result));
//
//   const r = await behaviourScan('base', rpcRaw, { blocks: 200 });
//   if (!r.trustworthy) throw new Error(`only read ${r.blocksScanned} blocks, ${r.chunksFailed} chunks failed`);
//   for (const c of r.candidates.slice(0, 10)) {
//     console.log(c.kind, c.address, c.distinctRecipients, 'recipients,', c.repeatRecipients, 'repeat');
//   }
//   // -> DISTRIBUTE 0x3770c1335714f1c44d6b670b69d5e7dc2e0915a5 4100 recipients, 655 repeat
//
//   // ALWAYS check `trustworthy` before acting on an empty list. `candidates: []` with
//   // trustworthy: false is a transport failure wearing the costume of a clean negative result.
//
// From the shell:  node behaviour-scan.mjs base 200        (scan)
//                  node behaviour-scan.mjs --selftest      (10 controls, no writes)
//
// FEEDING IT INTO discover.mjs: every returned `address` is a candidate contract, ranked. Hand it to
// `inspect()` / `simulateCandidate()` exactly like a `payersOf()` result. `discover.mjs :: isNoise()`
// is worth applying to the DISTRIBUTE rows — DEX routers and pools distribute constantly and never
// pay an arbitrary caller for showing up.

/** keccak256("Transfer(address,address,uint256)") — a constant, so this file needs no crypto library. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = '0x' + '0'.repeat(64);

/** Free RPCs reject > 10,000; see limit 3. Never raise this without re-measuring the provider. */
export const MAX_LOG_RANGE = 9999;

export const TRANSPORTS = Object.freeze({
  LOGS: 'eth_getLogs',                 // 1 call per chunk — cheap, but blocked on polygon
  RECEIPTS: 'eth_getBlockReceipts',    // 1 call per block — unrestricted everywhere measured
  AUTO: 'auto',                        // try LOGS once, fall back to RECEIPTS on refusal
});

const addrFromTopic = (t) => '0x' + t.slice(26).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// PURE CORE — no RPC, no clock, no network. Kept separate so it is testable deterministically.
// ---------------------------------------------------------------------------------------------

/**
 * Fold raw Transfer logs into ranked candidates. Pure: same logs in, same candidates out.
 * @param {Array} logs   raw log objects ({ address, topics, blockNumber })
 * @param {object} opts  { chain, minMintRecipients=3, minDistinctRecipients=4, isContract }
 *   `isContract` is a Map/Set/function answering "does this address have code". Optional — when it is
 *   omitted NOTHING is filtered out and every distributor is returned with `sourceHasCode: null`, so
 *   a caller can never mistake "not checked" for "checked and it is a contract".
 */
export function classify(logs, opts = {}) {
  const { chain = null, minMintRecipients = 3, minDistinctRecipients = 4, isContract = null } = opts;
  const hasCode = typeof isContract === 'function' ? isContract
    : isContract instanceof Map ? (a) => isContract.get(a)
      : isContract instanceof Set ? (a) => isContract.has(a)
        : null;

  const mints = new Map();     // token -> Set(recipient)
  const mintStd = new Map();   // token -> 'erc20' | 'erc721'
  const dist = new Map();      // `${token}|${src}` -> Map(recipient -> count)
  let counted = 0;

  for (const lg of logs) {
    const topics = lg && lg.topics;
    // ERC-20 Transfer has 3 topics; ERC-721 has 4 (tokenId is indexed). Anything shorter is a
    // different event that happens to share the signature hash prefix — skip it.
    if (!topics || topics.length < 3 || topics[0] !== TRANSFER_TOPIC) continue;
    const token = String(lg.address).toLowerCase();
    const to = topics[2];
    if (to === ZERO_TOPIC) continue;            // a burn pays nobody
    counted++;
    const rcpt = addrFromTopic(to);
    const std = topics.length >= 4 ? 'erc721' : 'erc20';
    if (topics[1] === ZERO_TOPIC) {
      if (!mints.has(token)) { mints.set(token, new Set()); mintStd.set(token, std); }
      mints.get(token).add(rcpt);
    } else {
      const src = addrFromTopic(topics[1]);
      if (src === rcpt) continue;               // self-transfer moves nothing to anybody
      const k = token + '|' + src;
      if (!dist.has(k)) dist.set(k, new Map());
      const m = dist.get(k);
      m.set(rcpt, (m.get(rcpt) || 0) + 1);
    }
  }

  const out = [];
  for (const [token, set] of mints) {
    if (set.size < minMintRecipients) continue;
    out.push({
      chain, address: token, kind: 'MINT', standard: mintStd.get(token),
      distinctRecipients: set.size, repeatRecipients: 0, payToken: token, sourceHasCode: true,
      why: `${set.size} distinct addresses received a mint (from 0x0) of this token in the window`,
    });
  }
  for (const [k, m] of dist) {
    const i = k.indexOf('|');
    const token = k.slice(0, i), src = k.slice(i + 1);
    if (m.size < minDistinctRecipients) continue;
    const code = hasCode ? hasCode(src) : null;
    if (code === false) continue;               // an EOA is not something anyone can call
    let repeats = 0;
    for (const v of m.values()) if (v > 1) repeats++;
    out.push({
      chain, address: src, kind: 'DISTRIBUTE', standard: 'erc20',
      distinctRecipients: m.size, repeatRecipients: repeats, payToken: token, sourceHasCode: code,
      why: `paid ${m.size} distinct recipients of ${token}${repeats ? `, ${repeats} of them more than once` : ''}`,
    });
  }

  // Repeat payers first: being paid twice is the cheapest evidence that a thing is repeatable.
  out.sort((a, b) => (b.repeatRecipients - a.repeatRecipients) || (b.distinctRecipients - a.distinctRecipients));
  return { candidates: out, transfersCounted: counted };
}

// ---------------------------------------------------------------------------------------------
// TRANSPORT — the same relation, two ways to buy it (see limit 1)
// ---------------------------------------------------------------------------------------------

/** Transfer logs for [from,to] via topic-filtered eth_getLogs. Throws if the provider refuses. */
export async function transfersViaLogs(rpcRaw, fromBlock, toBlock) {
  if (toBlock - fromBlock + 1 > MAX_LOG_RANGE) throw new Error(`range > ${MAX_LOG_RANGE} (limit 3)`);
  const res = await rpcRaw('eth_getLogs', [{
    fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16), topics: [TRANSFER_TOPIC],
  }]);
  // discover.mjs's rawCall returns null on RPC error rather than throwing; treat null as refusal.
  if (!Array.isArray(res)) throw new Error('eth_getLogs refused or returned no array');
  return res;
}

/** Transfer logs for [from,to] via per-block eth_getBlockReceipts. Works where getLogs is restricted. */
export async function transfersViaReceipts(rpcRaw, fromBlock, toBlock) {
  const out = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    const rcpts = await rpcRaw('eth_getBlockReceipts', ['0x' + b.toString(16)]);
    if (!Array.isArray(rcpts)) continue;
    for (const r of rcpts) for (const lg of (r.logs || [])) {
      if (lg.topics && lg.topics[0] === TRANSFER_TOPIC) out.push(lg);
    }
  }
  return out;
}

/**
 * Which transport does this endpoint actually allow?
 *
 * Probed TWICE before giving up, and never against the head block. Both details are bugs found by the
 * self-test rather than reasoned about: a single probe let a transient 429 downgrade base to the
 * per-block transport — 10x the RPC calls for the same data — on a chain whose eth_getLogs demonstrably
 * works; and the newest block is the one most likely to be un-indexed, so probing it fails for a reason
 * that has nothing to do with what the provider permits. A permission check has to fail only on
 * permission.
 */
export async function pickTransport(rpcRaw, headBlock) {
  const at = Math.max(0, headBlock - 3);
  for (let t = 0; t < 2; t++) {
    try {
      await transfersViaLogs(rpcRaw, at, at);
      return TRANSPORTS.LOGS;
    } catch {
      if (t === 0) await sleep(500);
    }
  }
  return TRANSPORTS.RECEIPTS;
}

// ---------------------------------------------------------------------------------------------
// THE SCAN
// ---------------------------------------------------------------------------------------------

/**
 * Scan a recent block window and return contracts ranked by giveaway footprint.
 *
 * @param {string}   chain    label only — carried onto every result row
 * @param {function} rpcRaw   (method, params) => result | null   (same shape discover.mjs injects)
 * @param {object}   opts
 *   blocks               how far back from head to scan          (default 300)
 *   chunk                blocks per eth_getLogs call             (default 10, clamped to MAX_LOG_RANGE)
 *   transport            'auto' | 'eth_getLogs' | 'eth_getBlockReceipts'
 *   minMintRecipients    (default 3)     minDistinctRecipients   (default 4)
 *   checkCode            verify each distributor has code        (default true; costs 1 call/source)
 *   codeConcurrency      (default 10)    pauseMs between chunks  (default 0)
 * @returns {Promise<{candidates, headBlock, blocksScanned, chunksFailed, transport, transfersCounted}>}
 */
export async function behaviourScan(chain, rpcRaw, opts = {}) {
  const {
    blocks = 300, chunk = 10, transport = TRANSPORTS.AUTO,
    minMintRecipients = 3, minDistinctRecipients = 4,
    checkCode = true, codeConcurrency = 10, pauseMs = 0,
  } = opts;

  const headHex = await rpcRaw('eth_blockNumber', []);
  if (!headHex) throw new Error(`behaviourScan(${chain}): eth_blockNumber failed — bad rpcRaw?`);
  const head = Number(BigInt(headHex));
  const span = Math.max(1, Math.min(chunk, MAX_LOG_RANGE));

  let mode = transport === TRANSPORTS.AUTO ? await pickTransport(rpcRaw, head) : transport;
  const auto = transport === TRANSPORTS.AUTO;

  // A transport that PASSES the probe can still start refusing mid-scan (measured: base publicnode
  // accepted the probe, then refused every chunk, and the scan returned 0 transfers while looking
  // like a chain with nothing on it). So each chunk falls back on its own, and a transport that keeps
  // failing is abandoned for the rest of the run. An empty result must mean an empty window, never a
  // transport that quietly stopped answering.
  const logs = [];
  let scanned = 0, chunksFailed = 0, degraded = 0;
  for (let off = 0; off < blocks; off += span) {
    const to = head - off;
    const from = Math.max(0, to - span + 1);
    let got = null;
    try {
      got = await (mode === TRANSPORTS.LOGS ? transfersViaLogs : transfersViaReceipts)(rpcRaw, from, to);
    } catch {
      if (auto && mode === TRANSPORTS.LOGS) {
        try { got = await transfersViaReceipts(rpcRaw, from, to); degraded++; } catch { got = null; }
      }
    }
    if (got) { logs.push(...got); scanned += to - from + 1; }
    else chunksFailed++;   // COUNTED, never swallowed (limit 3): missing evidence, not absent evidence
    // Two chunks that only worked by falling back means the primary is refusing, not flickering.
    if (auto && degraded >= 2 && mode === TRANSPORTS.LOGS) mode = TRANSPORTS.RECEIPTS;
    if (pauseMs) await sleep(pauseMs);
  }

  // Resolve code once per unique source, not once per log.
  let isContract = null;
  if (checkCode) {
    const srcs = new Set();
    for (const lg of logs) {
      if (!lg.topics || lg.topics.length < 3 || lg.topics[0] !== TRANSFER_TOPIC) continue;
      if (lg.topics[1] === ZERO_TOPIC) continue;
      srcs.add(addrFromTopic(lg.topics[1]));
    }
    const list = [...srcs];
    const map = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.max(1, codeConcurrency) }, async () => {
      while (i < list.length) {
        const a = list[i++];
        const code = await rpcRaw('eth_getCode', [a, 'latest']).catch(() => null);
        map.set(a, !!code && code !== '0x');
      }
    }));
    isContract = map;
  }

  const { candidates, transfersCounted } = classify(logs, { chain, minMintRecipients, minDistinctRecipients, isContract });
  for (const c of candidates) {
    c.headBlock = head;
    c.blocksScanned = scanned;
    c.src = `behaviour:${c.kind.toLowerCase()}(${c.distinctRecipients} recipients / ${scanned} blocks via ${mode})`;
  }
  return {
    candidates, headBlock: head, blocksScanned: scanned, chunksFailed, transport: mode, degraded,
    transfersCounted,
    // The one thing a consumer must not have to infer: did I read the window, or fail to read it?
    // Without this, "no candidates" and "no data" are the same empty array.
    trustworthy: scanned > 0 && chunksFailed === 0,
  };
}

/**
 * One row per (token, source) PAIR is what the scan returns, because a contract that pays three
 * different tokens is three different pieces of evidence. A consumer feeding `discover.mjs` wants
 * unique CONTRACTS instead — call this. Keeps the strongest row per address and records the rest.
 */
export function dedupe(candidates) {
  const best = new Map();
  for (const c of candidates) {
    const k = c.address.toLowerCase();
    const prev = best.get(k);
    if (!prev) { best.set(k, { ...c, payTokens: [c.payToken], rows: 1 }); continue; }
    if (!prev.payTokens.includes(c.payToken)) prev.payTokens.push(c.payToken);
    prev.rows++;
    if (c.repeatRecipients > prev.repeatRecipients ||
      (c.repeatRecipients === prev.repeatRecipients && c.distinctRecipients > prev.distinctRecipients)) {
      Object.assign(prev, c, { payTokens: prev.payTokens, rows: prev.rows });
    }
  }
  return [...best.values()]
    .sort((a, b) => (b.repeatRecipients - a.repeatRecipients) || (b.distinctRecipients - a.distinctRecipients));
}

// ---------------------------------------------------------------------------------------------
// DEFAULT RPCs — only so the file is runnable on its own. Callers should inject their own rpcRaw.
// ---------------------------------------------------------------------------------------------
// TWO endpoints per chain, not one. A single endpoint is a single point of rate-limiting, and a
// rate-limited endpoint does not look rate-limited from inside the scan — it looks like a chain with
// nothing on it. (Measured: sustained use of publicnode during one session degraded it to returning
// null for eth_blockNumber, which is indistinguishable from a dead chain unless you rotate.)
// Excluded deliberately: llamarpc answers with an HTML error page, which every JSON parse in a caller
// reads as a transport failure and retries away silently.
export const DEFAULT_RPCS = {
  base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  gnosis: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
  unichain: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org'],
};

/**
 * Build an rpcRaw of the shape discover.mjs injects: (method, params) => result.
 * THROWS when every endpoint and retry is exhausted — it never returns null on failure, because a
 * null that means "the provider is refusing" and a null that means "there is nothing here" are the
 * same value, and that ambiguity is precisely how a broken scan reports a clean zero.
 */
export function makeRpcRaw(chain, url = null) {
  const endpoints = url ? [url] : DEFAULT_RPCS[chain];
  if (!endpoints || !endpoints.length) throw new Error('no rpc for ' + chain);
  let i = 0;
  return async (method, params) => {
    let last = null;
    for (let t = 0; t < endpoints.length * 2; t++) {
      const endpoint = endpoints[i++ % endpoints.length];
      try {
        const r = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(30000),
        });
        if (r.status === 429) { last = new Error('429 ' + endpoint); await sleep(500 * (t + 1)); continue; }
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      } catch (e) { last = e; await sleep(200 * (t + 1)); }
    }
    throw last || new Error(`rpc exhausted for ${chain}:${method}`);
  };
}

// ---------------------------------------------------------------------------------------------
// SELF-TEST — the pure controls prove the logic, the live ones prove the claims in the header.
// ---------------------------------------------------------------------------------------------
export async function selftest({ live = true } = {}) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); ok ? pass++ : fail++; };
  const T = (from, to, address = '0xtok', extra = []) => ({ address, topics: [TRANSFER_TOPIC, from, to, ...extra], blockNumber: '0x1' });
  const A = (n) => '0x' + n.toString(16).padStart(64, '0');
  const SRC = A(0xabc);

  // --- pure controls (deterministic, no network) --------------------------------------------
  {
    const logs = [1, 2, 3, 4].map((n) => T(ZERO_TOPIC, A(n)));
    const { candidates } = classify(logs, { minMintRecipients: 3 });
    const m = candidates.find((c) => c.kind === 'MINT');
    check('mint class detected', !!m && m.distinctRecipients === 4, m ? `${m.distinctRecipients} recipients` : 'none');
  }
  {
    const logs = [1, 2, 3].map((n) => T(ZERO_TOPIC, A(n)));
    const { candidates } = classify(logs, { minMintRecipients: 4 });
    check('mint threshold respected', candidates.length === 0, `${candidates.length} returned`);
  }
  {
    const logs = [...[1, 2, 3, 4, 5].map((n) => T(SRC, A(n))), T(SRC, A(1)), T(SRC, A(1))];
    const { candidates } = classify(logs, { minDistinctRecipients: 4, isContract: new Set(['0x' + (0xabc).toString(16).padStart(40, '0')]) });
    const d = candidates.find((c) => c.kind === 'DISTRIBUTE');
    check('distribute + repeat counting', !!d && d.distinctRecipients === 5 && d.repeatRecipients === 1,
      d ? `${d.distinctRecipients} distinct / ${d.repeatRecipients} repeat` : 'none');
  }
  {
    // An EOA sender must be dropped — it is not something anyone else can call.
    const logs = [1, 2, 3, 4, 5].map((n) => T(SRC, A(n)));
    const { candidates } = classify(logs, { minDistinctRecipients: 4, isContract: () => false });
    check('EOA sources filtered out', candidates.length === 0, `${candidates.length} returned`);
  }
  {
    // Unchecked must be reported as null, never as true — "not checked" is not "it is a contract".
    const logs = [1, 2, 3, 4, 5].map((n) => T(SRC, A(n)));
    const { candidates } = classify(logs, { minDistinctRecipients: 4 });
    check('unchecked code reported as null', candidates[0] && candidates[0].sourceHasCode === null,
      String(candidates[0] && candidates[0].sourceHasCode));
  }
  {
    const burns = [1, 2, 3, 4, 5].map((n) => T(A(n), ZERO_TOPIC));
    const self = [1, 2, 3, 4, 5].map(() => T(SRC, SRC));
    const junk = [{ address: '0xtok', topics: ['0xdeadbeef', A(1), A(2)] }, { address: '0xtok', topics: [TRANSFER_TOPIC, A(1)] }];
    const { candidates } = classify([...burns, ...self, ...junk], { isContract: () => true });
    check('burns, self-transfers and non-Transfer logs ignored', candidates.length === 0, `${candidates.length} returned`);
  }
  {
    // ERC-721 carries a 4th topic; recipients must still be counted, and the standard reported.
    const logs = [1, 2, 3, 4].map((n) => T(ZERO_TOPIC, A(n), '0xnft', [A(n)]));
    const { candidates } = classify(logs, { minMintRecipients: 3 });
    check('erc721 mints counted and labelled', candidates[0] && candidates[0].standard === 'erc721' && candidates[0].distinctRecipients === 4,
      candidates[0] ? candidates[0].standard : 'none');
  }
  {
    const logs = [...[1, 2, 3, 4].map((n) => T(SRC, A(n))), ...[5, 6, 7, 8, 9].map((n) => T(A(0xdef), A(n))), T(SRC, A(1))];
    const { candidates } = classify(logs, { minDistinctRecipients: 4, isContract: () => true });
    check('ranked by repeat payers first', candidates[0].repeatRecipients >= candidates[1].repeatRecipients,
      candidates.map((c) => c.repeatRecipients).join(' >= '));
  }
  {
    // One source paying two different tokens is two rows but ONE contract to hand to discover.mjs.
    const logs = [...[1, 2, 3, 4].map((n) => T(SRC, A(n), '0xtokA')), ...[1, 2, 3, 4, 5].map((n) => T(SRC, A(n), '0xtokB'))];
    const { candidates } = classify(logs, { minDistinctRecipients: 4, isContract: () => true });
    const u = dedupe(candidates);
    check('dedupe collapses one contract paying several tokens',
      candidates.length === 2 && u.length === 1 && u[0].payTokens.length === 2 && u[0].distinctRecipients === 5,
      `${candidates.length} rows -> ${u.length} contract, ${u[0].payTokens.length} tokens`);
  }

  // --- live controls (prove the header's claims are still true) ------------------------------
  if (live) {
    try {
      // Limit 1: the two transports must agree, or the polygon fallback is not a substitute.
      const rpc = makeRpcRaw('base');
      const head = Number(BigInt(await rpc('eth_blockNumber', []))) - 3;
      const [a, b] = await Promise.all([transfersViaLogs(rpc, head, head), transfersViaReceipts(rpc, head, head)]);
      check('transports agree on the same block (limit 1)', a.length === b.length && a.length > 0,
        `getLogs=${a.length} getBlockReceipts=${b.length} @ base ${head}`);
    } catch (e) { check('transports agree on the same block (limit 1)', false, String(e.message).slice(0, 90)); }

    try {
      // Limit 1 continued. Asserting "polygon MUST refuse getLogs" was wrong and the self-test caught
      // it: publicnode's restriction is inconsistent — it refused topic-only queries at spans 10, 3 and
      // 1 earlier in the same session, then served a single block minutes later. The claim worth
      // holding is the CAPABILITY (polygon is scannable at all), not the MECHANISM (which route wins).
      // A test that pins the mechanism fails on a healthy system, which is worse than no test.
      const rpc = makeRpcRaw('polygon');
      const head = Number(BigInt(await rpc('eth_blockNumber', [])));
      const got = await transfersViaReceipts(rpc, head - 1, head - 1);
      check('polygon is scannable via the receipts route (limit 1)', got.length > 0, `${got.length} transfers via receipts`);
      const r = await behaviourScan('polygon', rpc, { blocks: 4, chunk: 2 });
      check('polygon end-to-end scan reads its window', r.trustworthy && r.transfersCounted > 0,
        `${r.transfersCounted} transfers, ${r.blocksScanned} blocks via ${r.transport}, failed=${r.chunksFailed}, degraded=${r.degraded}`);
    } catch (e) { check('polygon is scannable via the receipts route (limit 1)', false, String(e.message).slice(0, 90)); }

    try {
      // Limit 3: over-range must be refused, and must be VISIBLE as a failure, not as emptiness.
      const rpc = makeRpcRaw('base');
      const head = Number(BigInt(await rpc('eth_blockNumber', [])));
      let threw = false, msg = '';
      try { await transfersViaLogs(rpc, head - MAX_LOG_RANGE - 5000, head); } catch (e) { threw = true; msg = e.message; }
      check('an over-range window is refused loudly, never as an empty result (limit 3)', threw,
        `cap ${MAX_LOG_RANGE}; refused with "${msg.slice(0, 50)}"`);
    } catch (e) { check('over-range getLogs throws rather than returning empty (limit 3)', false, String(e.message).slice(0, 90)); }

    try {
      // End to end: a real scan must return real candidates whose sources really have code.
      const r = await behaviourScan('base', makeRpcRaw('base'), { blocks: 30, chunk: 10 });
      const dist = r.candidates.filter((c) => c.kind === 'DISTRIBUTE');
      check('end-to-end scan returns candidates', r.candidates.length > 0 && r.transfersCounted > 0 && r.trustworthy,
        `${r.candidates.length} candidates from ${r.transfersCounted} transfers, ${r.blocksScanned} blocks via ${r.transport}, failed=${r.chunksFailed}, degraded=${r.degraded}`);
      check('every distributor returned has code', dist.every((c) => c.sourceHasCode === true), `${dist.length} distributors`);
      // Transport selection, pinned to MY logic rather than to the provider's mood. Ask the endpoint
      // directly whether it will serve a topic-only getLogs right now, then require the module to
      // agree with that answer — and require the window to be read either way. (An earlier version
      // asserted "base always picks getLogs" and failed on a working system the moment publicnode
      // started rate-limiting mid-run: the module had correctly degraded and read all 2,886 transfers.)
      const rpc2 = makeRpcRaw('base');
      const h2 = Number(BigInt(await rpc2('eth_blockNumber', [])));
      let logsWork = true;
      try { await transfersViaLogs(rpc2, h2 - 3, h2 - 3); } catch { logsWork = false; }
      const picked = await pickTransport(rpc2, h2);
      check('transport choice matches what the endpoint actually permits',
        logsWork ? picked === TRANSPORTS.LOGS : picked === TRANSPORTS.RECEIPTS,
        `getLogs ${logsWork ? 'permitted' : 'refused'} right now -> picked ${picked}`);
      check('window is read whichever transport wins', r.trustworthy && r.transfersCounted > 0,
        `${r.transfersCounted} transfers via ${r.transport}, degraded=${r.degraded}, failed=${r.chunksFailed}`);
    } catch (e) { check('end-to-end scan returns candidates', false, String(e.message).slice(0, 90)); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return { pass, fail };
}

// ---------------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] || '').endsWith('behaviour-scan.mjs')) {
  if (process.argv.includes('--selftest')) {
    const { fail } = await selftest({ live: !process.argv.includes('--offline') });
    process.exit(fail ? 1 : 0);
  } else {
    const chain = process.argv[2] || 'base';
    const blocks = Number(process.argv[3] || 200);
    const r = await behaviourScan(chain, makeRpcRaw(chain), { blocks });
    const uniq = dedupe(r.candidates);
    console.log(`${chain}: ${r.blocksScanned} blocks (head ${r.headBlock}) via ${r.transport}, ` +
      `${r.transfersCounted} transfers, ${r.chunksFailed} chunks failed, degraded ${r.degraded} -> ` +
      `${r.candidates.length} rows / ${uniq.length} unique contracts` +
      `  [trustworthy: ${r.trustworthy ? 'YES' : 'NO — an empty list here would mean UNREAD, not absent'}]`);
    for (const c of uniq.slice(0, 20)) {
      console.log(` ${c.kind.padEnd(10)} ${c.address} ${String(c.distinctRecipients).padStart(5)} recipients ` +
        `${String(c.repeatRecipients).padStart(4)} repeat  ${c.standard}${c.payTokens.length > 1 ? `  (${c.payTokens.length} tokens)` : ''}`);
    }
  }
}
