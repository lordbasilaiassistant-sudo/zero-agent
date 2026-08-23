// sponsors.mjs — find the whole species, not one specimen.
//
// HOW WE FOUND SAFE, AND WHY THAT WAS THE WEAK PART: we searched for "a relayer with no API key",
// read marketing pages, and tried the named products until one worked. That is catalogue lookup. It
// can only ever return what somebody already wrote up, so it found us a PRODUCT — and we inherited
// its 5-per-chain-per-day cap as though it were a law of physics. It is not. It is one vendor's
// rate limit on one vendor's front end.
//
// FIRST PRINCIPLES: we never needed "Safe's relay". We needed a strictly simpler thing —
//
//        SOMEBODY ELSE'S TRANSACTION CARRIES OUR STATE CHANGE.
//
// That is a RELATION, and relations on a public chain are directly observable. Every gas sponsor that
// has ever existed leaves the same footprint: an address that repeatedly pays fees for transactions
// whose beneficiary is not itself. No documentation required, no vendor required, no training data
// required. Enumerating that footprint returns the ENTIRE population — including sponsors with no
// website, no docs, and no name, which is exactly the set that catalogue lookup can never reach.
//
// Measured fingerprint, taken from the two addresses that actually paid for ZERO's own transactions
// (0x00AE928D…3C2A and 0xE2D4A7ff…733C):
//   * externally-owned account, not a contract
//   * very high transaction volume
//   * near-total method concentration — 50/50 sampled txs were the same call
//   * MANY distinct destinations: it serves unrelated parties, which is what separates a relayer
//     from a bot that only ever operates its own positions
//
// THE CONTROL EXPERIMENT (this is why the method is trustworthy rather than merely clever): a new
// instrument must reproduce the known result before its novel results mean anything. Run this and it
// has to rediscover those two addresses from observation alone. `controlTest()` below asserts exactly
// that. If the control fails, every novel sponsor it reports is noise.

const SCOUT = {
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
};

// Known ground truth: these paid for ZERO's transactions. The control must find them.
export const KNOWN_SPONSORS = [
  '0x00ae928d24a4450bfbb70bbdd7d3d3f163513c2a',
  '0xe2d4a7ff2b7bb9f92ad5d1edd438224c1646733c',
];

// P1-2 FIX: ground-truth NON-sponsors — high-volume EOAs that only ever operate their own
// positions. A true-positive-only control is passed by an instrument that returns "sponsor" for
// every input, which is exactly what the fingerprint was (30/30 active EOAs passed, 21 STRONG).
// If any of these score >=70 the fingerprint is not discriminating and its output is noise.
export const KNOWN_NON_SPONSORS = [
  '0x1ef9d9240d83a1cf120c6fa7658ca47d005532d0',   // price keeper, 1 destination, conc 1.0 — scored 72
  '0xd52f194ff7b52aae71b1485228a50460da1eaefc',   // single-contract bot — scored 72
];

// Public rendezvous points where sponsors are forced to reveal themselves. Anyone who submits work on
// someone else's behalf must eventually touch one of these, so enumerating their callers enumerates
// the species. This list is a starting set, not a limit — any forwarder we discover becomes a new hub.
export const HUBS = {
  base: [
    { addr: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', what: 'ERC-4337 EntryPoint v0.7 — every bundler on this chain calls it' },
    { addr: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', what: 'ERC-4337 EntryPoint v0.6 — older bundlers' },
  ],
};

const lc = (s) => String(s || '').toLowerCase();
const j = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'zero-agent/0.4' } });
  if (!r.ok) throw new Error(`${r.status} ${u.slice(0, 80)}`);
  return r.json();
};

/**
 * Enumerate the addresses that submit transactions INTO a hub.
 *
 * ⚠️ P1-3 FIX, stated plainly: for an ERC-4337 EntryPoint this returns BUNDLERS — the couriers who
 * call handleOps and are REIMBURSED out of the userOp's prefund or by the paymaster. They are the
 * one party in a 4337 flow structurally guaranteed NOT to pay for us. The entity that actually pays
 * is the PAYMASTER — topics[3] of UserOperationEvent (gasrouter.mjs already extracts it). Measured:
 * 41% of recent Base userOps had third-party gas, and every one of those payers is invisible to
 * this function. Use `paymastersOfEntryPoint` below for the payer population.
 */
export async function sponsorsOfHub(chain, hub, pages = 2) {
  const base = SCOUT[chain];
  if (!base) throw new Error(`no Blockscout endpoint configured for "${chain}"`);
  const counts = {};
  let next = null;
  for (let p = 0; p < pages; p++) {
    const q = next ? '&' + new URLSearchParams(next).toString() : '';
    let res;
    try { res = await j(`${base}/api/v2/addresses/${hub}/transactions?filter=to${q}`); }
    catch { break; }
    for (const t of res.items || []) {
      if (t.status !== 'ok') continue;
      const from = lc(t.from?.hash);
      if (!from) continue;
      const c = (counts[from] ||= { address: t.from.hash, txs: 0, methods: {}, is_contract: !!t.from?.is_contract });
      c.txs++;
      c.methods[t.method || '(raw)'] = (c.methods[t.method || '(raw)'] || 0) + 1;
    }
    next = res.next_page_params;
    if (!next) break;
  }
  return Object.values(counts).sort((a, b) => b.txs - a.txs);
}

/**
 * P1-3 FIX: the PAYERS, not the couriers. Walk UserOperationEvent logs off an EntryPoint and return
 * the paymaster population — topics[3] is the paymaster that actually covered the gas. This is the
 * list worth admission-testing; `sponsorsOfHub` returns the reimbursed submitters.
 */
export const USER_OP_EVENT_TOPIC = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
export async function paymastersOfEntryPoint(chain, entryPoint, { blocks = 400, rpc = null } = {}) {
  if (!rpc) throw new Error('paymastersOfEntryPoint needs an rpc(chain, method, params) — log enumeration cannot run over Blockscout tx pages');
  const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16);
  const logs = await rpc(chain, 'eth_getLogs', [{
    address: entryPoint, topics: [USER_OP_EVENT_TOPIC],
    fromBlock: '0x' + Math.max(0, head - blocks).toString(16), toBlock: 'latest',
  }]);
  const pays = {};
  let ops = 0;
  for (const l of logs || []) {
    ops++;
    if (!l.topics?.[3]) continue;
    const pm = '0x' + l.topics[3].slice(26).toLowerCase();
    if (/^0x0+$/.test(pm)) continue;                       // no paymaster = the sender paid its own gas
    pays[pm] = (pays[pm] || 0) + 1;
  }
  return {
    chain, entryPoint, ops_observed: ops, third_party_paid: Object.values(pays).reduce((a, b) => a + b, 0),
    note: 'These are the entities that PAID for other accounts\' operations — the sponsor population the hub walk could never see.',
    paymasters: Object.entries(pays).sort((a, b) => b[1] - a[1]).map(([address, n]) => ({ address, ops_sponsored: n })),
  };
}

/**
 * Score an address against the measured sponsor fingerprint. Deliberately behavioural — it never asks
 * what something is CALLED, only what it DOES, which is the whole point.
 */
export async function fingerprint(chain, address) {
  const base = SCOUT[chain];
  // P2-6 FIX: an unreachable chain used to report "no outbound transactions" — a confident fact
  // about a chain we never touched (`undefined/api/v2/...` swallowed by a catch).
  if (!base) return { address, chain, sponsor_score: null, unmeasured: true, why: `no Blockscout endpoint configured for "${chain}" — NOT a measurement` };
  const info = await j(`${base}/api/v2/addresses/${address}`).catch(() => ({}));
  let txs;
  try { txs = await j(`${base}/api/v2/addresses/${address}/transactions?filter=from`); }
  catch (e) { return { address, chain, sponsor_score: null, unmeasured: true, why: 'explorer read failed: ' + String(e.message).slice(0, 60) }; }
  const items = (txs.items || []).filter(t => t.status === 'ok');
  if (!items.length) return { address, sponsor_score: 0, why: 'no outbound transactions' };

  const methods = {};
  const dests = new Set();
  let paidForOthers = 0;
  for (const t of items) {
    methods[t.method || '(raw)'] = (methods[t.method || '(raw)'] || 0) + 1;
    if (t.to?.hash) dests.add(lc(t.to.hash));
    // P1-1 FIX: "pays a fee to a contract that is not its own" describes EVERY transaction any EOA
    // has ever sent — it scored a constant +20 and 30/30 sampled EOAs passed. The defining act of a
    // sponsor is that the BENEFICIARY is someone else: the call carries an inner party (4337 sender,
    // ERC-2771 from, Safe exec target) that is not the submitter. Count only what we can establish.
    const params = t.decoded_input?.parameters || [];
    const inner = lc(params.find(p => /sender|from|account|user|safe/i.test(p.name || ''))?.value || '');
    if (inner && /^0x[0-9a-f]{40}$/.test(inner) && inner !== lc(address)) paidForOthers++;
  }
  const top = Object.entries(methods).sort((a, b) => b[1] - a[1])[0] || ['(none)', 0];
  const concentration = top[1] / items.length;          // relayers do ONE job, repeatedly
  const spread = dests.size;                            // ...for MANY unrelated parties
  const isEoa = info.is_contract === false;

  // P1-1 FIX: a single-purpose bot (spread < 5 distinct destinations) can NEVER be "submitting one
  // job type for many unrelated parties", whatever the other terms sum to.
  if (spread < 5) {
    return {
      address, is_eoa: isEoa, name: info.name || null,
      sampled: items.length, dominant_method: top[0], method_concentration: +concentration.toFixed(2),
      distinct_destinations: spread, sponsor_score: 0,
      verdict: 'not a sponsor — serves fewer than 5 distinct destinations (operates its own positions)',
    };
  }

  // Weights follow the measured fingerprint, not intuition.
  const score = (isEoa ? 25 : 0)
    + Math.min(30, spread * 2)
    + (concentration > 0.8 ? 25 : concentration > 0.5 ? 12 : 0)
    + Math.min(20, Math.round((paidForOthers / items.length) * 20));

  return {
    address, is_eoa: isEoa, name: info.name || null,
    sampled: items.length, dominant_method: top[0], method_concentration: +concentration.toFixed(2),
    distinct_destinations: spread, sponsor_score: score,
    verdict: score >= 70 ? 'STRONG sponsor signature — submits one job type for many unrelated parties'
      : score >= 45 ? 'possible sponsor'
        : 'not a sponsor (looks like a bot operating its own positions)',
  };
}

/**
 * THE CONTROL. Reproduce the known result from observation, or do not believe the novel ones.
 * Both addresses are fed in blind and must independently score as sponsors on behaviour alone.
 */
export async function controlTest(chain = 'base') {
  const results = [];
  for (const a of KNOWN_SPONSORS) results.push(await fingerprint(chain, a));
  // P1-2 FIX: the NEGATIVE arm — the arm that can fail. A true-positive-only control is passed by
  // an instrument that answers "sponsor" for every input, which is exactly what this was.
  const negatives = [];
  for (const a of KNOWN_NON_SPONSORS) negatives.push(await fingerprint(chain, a));
  const passedPositives = results.every(r => r.sponsor_score >= 70);
  const passedNegatives = negatives.every(r => (r.sponsor_score ?? 100) < 45);
  return {
    control: 'must rediscover the two addresses that really paid for ZERO transactions AND reject the two that only ever operated their own positions',
    passed: passedPositives && passedNegatives,
    positive_arm_passed: passedPositives,
    negative_arm_passed: passedNegatives,
    results,
    negatives,
    meaning: passedPositives && passedNegatives
      ? 'Instrument reproduces the known result AND rejects known non-sponsors. Novel sponsors it reports are worth testing.'
      : !passedPositives
        ? 'Instrument FAILED to recognise a sponsor we have ground truth for. Do not trust its novel output; fix the fingerprint first.'
        : 'Instrument still accepts known NON-sponsors (specificity failure) — its novel sponsor list is noise until the fingerprint discriminates.',
  };
}

/** Sweep the hubs and return the sponsor population, best first. */
export async function discoverSponsors(chain = 'base', { hubs = HUBS[chain] || [], top = 8 } = {}) {
  if (!HUBS[chain]) {
    return [{ address: null, chain, unmeasured: true, why: `no hub list configured for "${chain}" — NOT "no sponsors here"` }];
  }
  const seen = {};
  for (const h of hubs) {
    const callers = await sponsorsOfHub(chain, h.addr);
    for (const c of callers.slice(0, top)) {
      const k = lc(c.address);
      (seen[k] ||= { ...c, hubs: [] }).hubs.push(h.what);
    }
  }
  // P2-5 FIX: slice(0, top) ran on HUB INSERTION order, so whichever hub was enumerated first kept
  // every slot — measured 20 of 59+27 candidates structurally unreachable, including all three
  // busiest v0.6 callers. Rank the WHOLE candidate set by observed activity, then cut.
  const cands = Object.values(seen).sort((a, b) => b.txs - a.txs).slice(0, top * 2);
  const out = [];
  for (const c of cands) {
    const f = await fingerprint(chain, c.address);
    out.push({ ...f, hub_txs: c.txs, hubs: c.hubs });
  }
  return out.sort((a, b) => b.sponsor_score - a.sponsor_score).slice(0, top);
}
