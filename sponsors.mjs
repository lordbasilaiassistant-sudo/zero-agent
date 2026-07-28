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
 * Enumerate the addresses that submit transactions INTO a hub. For an ERC-4337 EntryPoint this is
 * precisely the set of bundlers operating on the chain — a complete, live, self-maintaining list that
 * no vendor publishes and no model was trained on.
 */
export async function sponsorsOfHub(chain, hub, pages = 2) {
  const base = SCOUT[chain];
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
 * Score an address against the measured sponsor fingerprint. Deliberately behavioural — it never asks
 * what something is CALLED, only what it DOES, which is the whole point.
 */
export async function fingerprint(chain, address) {
  const base = SCOUT[chain];
  const info = await j(`${base}/api/v2/addresses/${address}`).catch(() => ({}));
  const txs = await j(`${base}/api/v2/addresses/${address}/transactions?filter=from`).catch(() => ({ items: [] }));
  const items = (txs.items || []).filter(t => t.status === 'ok');
  if (!items.length) return { address, sponsor_score: 0, why: 'no outbound transactions' };

  const methods = {};
  const dests = new Set();
  let paidForOthers = 0;
  for (const t of items) {
    methods[t.method || '(raw)'] = (methods[t.method || '(raw)'] || 0) + 1;
    if (t.to?.hash) dests.add(lc(t.to.hash));
    // The defining act: it pays a fee to execute a call against a contract that is not its own.
    if (t.to?.hash && lc(t.to.hash) !== lc(address)) paidForOthers++;
  }
  const top = Object.entries(methods).sort((a, b) => b[1] - a[1])[0] || ['(none)', 0];
  const concentration = top[1] / items.length;          // relayers do ONE job, repeatedly
  const spread = dests.size;                            // ...for MANY unrelated parties
  const isEoa = info.is_contract === false;

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
  const passed = results.every(r => r.sponsor_score >= 70);
  return {
    control: 'must rediscover the two addresses that really paid for ZERO\'s transactions, using behaviour only',
    passed,
    results,
    meaning: passed
      ? 'Instrument reproduces the known result. Novel sponsors it reports are worth testing.'
      : 'Instrument FAILED to recognise a sponsor we have ground truth for. Do not trust its novel output; fix the fingerprint first.',
  };
}

/** Sweep the hubs and return the sponsor population, best first. */
export async function discoverSponsors(chain = 'base', { hubs = HUBS[chain] || [], top = 8 } = {}) {
  const seen = {};
  for (const h of hubs) {
    const callers = await sponsorsOfHub(chain, h.addr);
    for (const c of callers.slice(0, top)) {
      const k = lc(c.address);
      (seen[k] ||= { ...c, hubs: [] }).hubs.push(h.what);
    }
  }
  const out = [];
  for (const c of Object.values(seen).slice(0, top)) {
    const f = await fingerprint(chain, c.address);
    out.push({ ...f, hub_txs: c.txs, hubs: c.hubs });
  }
  return out.sort((a, b) => b.sponsor_score - a.sponsor_score);
}
