// experiments.mjs — the part that never stops looking.
//
// Everything else in this repo exploits what we already know. This runs EXPERIMENTS: cheap,
// falsifiable probes of mechanism classes we do not yet know pay, forever, on a cron, with every
// result written down whether it worked or not. A negative is not a failure here — it permanently
// narrows the map, and the map is the compounding asset.
//
// DESIGN RULES, each one paid for in this project:
//  * Only VALUABLE tokens count. The first skim scan found two pairs with real excess — 28.6M XMN and
//    some GLOOM — both illiquid microcaps worth ~$0. That is not bad luck, it is a SELECTION EFFECT:
//    excess accumulates in pairs whose tokens are weird (fee-on-transfer, rebasing), and weird tokens
//    are usually worthless. So findings are denominated in a priced-token whitelist or they do not
//    count at all.
//  * Every experiment states its own falsification and its own cost before it runs.
//  * Every run is logged with its finding AND its null result, because "we checked 420 pairs and found
//    nothing valuable" is information the next run needs.
//  * Nothing here spends a relay slot. Discovery is free; only execution is scarce.
import { ethers } from 'ethers';

const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
const balOf = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');

// Only excess denominated in something we can actually sell counts as a finding.
export const PRICED = {
  base: {
    '0x4200000000000000000000000000000000000006': { sym: 'WETH', dec: 18, usd: 1920 },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { sym: 'USDC', dec: 6, usd: 1 },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { sym: 'DAI', dec: 18, usd: 1 },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { sym: 'USDbC', dec: 6, usd: 1 },
    '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { sym: 'wstETH', dec: 18, usd: 2280 },
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { sym: 'cbETH', dec: 18, usd: 2050 },
  },
};

async function agg(rpc, chain, calls) {
  const ret = await rpc(chain, 'eth_call', [{ to: MC, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
  return AGG.decodeFunctionResult('aggregate3', ret)[0];
}

// ── EXPERIMENT 1 — Uniswap-V2 skim dust ─────────────────────────────────────
// A V2 pair caches reserve0/reserve1. Real balanceOf(pair) drifts ABOVE the cache whenever tokens
// arrive without a swap: fee-on-transfer leakage, positive rebases, plain mis-sends. `skim(to)` sends
// that excess to ANY address the caller names — permissionless, zero capital, and emergent, since
// neither the token author nor the pool author intended the gap.
//
// MEASURED 2026-07-28: the mechanism is REAL — 2 of 420 Base pairs carried excess. Both were
// worthless microcaps, so the experiment now only counts excess in priced tokens. There are ~3.04M
// V2 pairs on Base; a cursor walks them forever, a few hundred per tick.
export const SKIM = {
  id: 'v2-skim-dust',
  question: 'Does any Uniswap-V2-fork pair hold WETH/USDC above its cached reserves, claimable by skim(to)?',
  falsification: 'balanceOf(token,pair) > getReserves() for a PRICED token. One batched eth_call per 25 pairs.',
  cost: 'free — read only',
  factories: {
    base: [
      '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Uniswap V2
      '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB', // BaseSwap
      '0x71524B4f93c58fcbF659783284E38825f0622859', // SushiSwap V2
    ],
  },
};

export async function runSkimScan(env, rpc, chain = 'base', { pairs = 240 } = {}) {
  // P2-8 FIX: PRICED and SKIM.factories have a `base` key and nothing else, inside a function that
  // takes `chain`. On any other chain this returned a confident negative after ZERO RPC calls,
  // citing a Base measurement as if it applied — a config gap dressed as a result.
  if (!PRICED[chain] || !SKIM.factories[chain]) {
    return {
      experiment: SKIM.id, chain, unsupported: true,
      conclusion: `NOT MEASURED on ${chain}: no PRICED token table and no V2 factory list for this chain. This is a gap in the config, NOT a negative result — do not record it as "checked and found nothing".`,
    };
  }
  const st = (await env.KV.get('exp:skim', 'json')) || { cursor: {}, checked: 0, found: [] };
  const priced = PRICED[chain] || {};
  const facs = SKIM.factories[chain] || [];
  const list = [];
  let failedBatches = 0;

  for (const f of facs) {
    const cur = st.cursor[f] || 0;
    let len = 0;
    try { len = Number(BigInt(await rpc(chain, 'eth_call', [{ to: f, data: '0x574f2ba3' }, 'latest']))); } catch { continue; }
    if (!len) continue;
    // P2-17 FIX: every factory got `pairs / facs.length` slots regardless of size — an 80-slot tick
    // covers 1/38k of Uniswap-V2 (3.04M pairs ≈ 105 days per pass) while re-reading BaseSwap's
    // whole 8k-pair universe every 103 ticks. Allocate proportional to actual size.
    const take = Math.max(1, Math.round(pairs * (len / facs.reduce((n, f2) => n + Number(st.factoryLen?.[f2] || 0), 0) || len)));
    const idx = [];
    for (let k = 0; k < take; k++) idx.push((cur + k) % len);
    // P2-7 FIX: the cursor used to be committed BEFORE any pair was read and every RPC failure was
    // swallowed — one hiccup permanently skipped 240 pairs while writing "we checked and found
    // nothing" into the log. Only advance past pairs we actually read.
    let read = 0;
    for (let s = 0; s < idx.length; s += 60) {
      const sliceIdx = idx.slice(s, s + 60);
      const calls = sliceIdx.map(n => ({ target: f, allowFailure: true,
        callData: '0x1e3dd18b' + n.toString(16).padStart(64, '0') }));
      try {
        for (const r of await agg(rpc, chain, calls)) {
          if (r.success && r.returnData !== '0x') list.push('0x' + r.returnData.slice(26));
        }
        read += sliceIdx.length;
      } catch { failedBatches++; }
    }
    st.cursor[f] = (cur + (read || 0)) % len;
    st.factoryLen = { ...(st.factoryLen || {}), [f]: len };   // sizes for the proportional split above
  }

  const hits = [];
  for (let s = 0; s < list.length; s += 25) {
    const slice = list.slice(s, s + 25);
    let meta;
    try {
      meta = await agg(rpc, chain, slice.flatMap(p => ([
        { target: p, allowFailure: true, callData: '0x0dfe1681' },   // token0
        { target: p, allowFailure: true, callData: '0xd21220a7' },   // token1
        { target: p, allowFailure: true, callData: '0x0902f1ac' },   // getReserves
      ])));
    } catch { continue; }

    const want = [];
    for (let k = 0; k < slice.length; k++) {
      const t0 = meta[k * 3], t1 = meta[k * 3 + 1], re = meta[k * 3 + 2];
      if (!t0?.success || !t1?.success || !re?.success || re.returnData.length < 130) continue;
      const a0 = ('0x' + t0.returnData.slice(26)).toLowerCase();
      const a1 = ('0x' + t1.returnData.slice(26)).toLowerCase();
      // Skip the pair entirely unless at least one side is a token we could actually sell.
      if (!priced[a0] && !priced[a1]) continue;
      want.push({ pair: slice[k], a0, a1,
        r0: BigInt('0x' + re.returnData.slice(2, 66)), r1: BigInt('0x' + re.returnData.slice(66, 130)) });
    }
    if (!want.length) continue;

    let bals;
    try {
      bals = await agg(rpc, chain, want.flatMap(w => ([
        { target: w.a0, allowFailure: true, callData: balOf(w.pair) },
        { target: w.a1, allowFailure: true, callData: balOf(w.pair) },
      ])));
    } catch { continue; }

    for (let k = 0; k < want.length; k++) {
      st.checked++;
      const w = want[k], b0 = bals[k * 2], b1 = bals[k * 2 + 1];
      if (!b0?.success || !b1?.success) continue;
      try {
        for (const [addr, bal, res] of [[w.a0, BigInt(b0.returnData), w.r0], [w.a1, BigInt(b1.returnData), w.r1]]) {
          const p = priced[addr];
          if (!p) continue;                              // unpriced excess is not a finding
          const d = bal - res;
          if (d <= 0n) continue;
          const usd = (Number(d) / 10 ** p.dec) * p.usd;
          if (usd > 0.0005) hits.push({ pair: w.pair, token: addr, sym: p.sym, wei: d.toString(), usd: +usd.toFixed(6) });
        }
      } catch { /* undecodable */ }
    }
  }

  hits.sort((a, b) => b.usd - a.usd);
  st.found = [...hits, ...(st.found || [])].slice(0, 40);
  st.lastRun = new Date().toISOString();
  await env.KV.put('exp:skim', JSON.stringify(st));
  return {
    experiment: SKIM.id, question: SKIM.question,
    pairs_sampled: list.length, priced_pairs_checked: st.checked,
    rpc_batches_failed: failedBatches,
    hits: hits.slice(0, 10), best_usd: hits[0]?.usd || 0,
    cursor: st.cursor,
    // P2-7 FIX: a failed batch is INCONCLUSIVE, never a clean negative — those pairs were not measured.
    conclusion: failedBatches
      ? `INCONCLUSIVE — ${failedBatches} batch(es) failed; those pairs were NOT measured and the cursor did not advance past them. Retry next tick.`
      : hits.length
        ? `${hits.length} pair(s) hold claimable priced excess — best $${hits[0].usd}. skim(to=YOUR SAFE) takes it.`
        : 'No priced excess in this slice. Mechanism is real (measured: 2/420 pairs carried excess) but the leaks land in worthless microcaps — a selection effect, since only weird tokens leak. Cursor advanced; the sweep continues.',
  };
}

// ── EXPERIMENT 2 — abandonment (Fable's Class A) ─────────────────────────────
// The equilibrium argument: in LIVE markets competition bids keeper bounties down to the gas floor,
// which is exactly why every live class we have found is dust. That cap breaks in one place —
// ABANDONMENT. A bounty sized for a busy, high-gas era on a protocol nobody watches any more is
// uncontested at its ORIGINAL size, which can be pennies-to-dollars rather than sub-gas dust.
//
// Fingerprint: a contract that USED to emit an incentive event and has gone quiet, but still holds a
// reward-token balance and still exposes a permissionless entry point.
export const ABANDONED = {
  id: 'abandoned-incentives',
  question: 'Which contracts used to pay callers, went silent, and still hold a balance they would pay out?',
  falsification: 'getLogs density collapse -> still holds priced token -> payout oracle returns delta > 0.',
  cost: 'free — read only',
  topics: {
    // P1-6 fix: Harvest/Compounded/Distributed measured ZERO logs in both windows on Base — 3 of the
    // original 4 topics were dead, so 75% of the RPC cost bought nothing.
    RewardPaid: ethers.id('RewardPaid(address,uint256)'),
    HarvesterHarvest: ethers.id('Harvest(address,address,uint256)'),
  },
};

// P1-6 FIX. The old shape compared a 30-minute window against a 20-hour one and called the delta
// "abandoned" — a healthy hourly harvester qualifies. Measured: 4 of 5 nominees were ALIVE (80%
// false positives), each blacklisted forever via st.seen. Abandonment needs ~a month of silence,
// assembled from ≤10,000-block getLogs windows (provider limit), and a partial failure must ABORT:
// a failed recent window nominates every old emitter at once.
const RECENT_SPAN_BLOCKS = 129600;   // ≈30 days at 2s blocks
const SCAN_WINDOW = 10000;           // eth_getLogs range cap, measured

export async function runAbandonScan(env, rpc, chain = 'base', { window = SCAN_WINDOW, recentSpan = RECENT_SPAN_BLOCKS, lookback = 40 } = {}) {
  const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16);
  const recent = {}, old = {};
  let scanFailed = false;
  const scan = async (from, to, bucket) => {
    for (const [, topic] of Object.entries(ABANDONED.topics)) {
      try {
        const logs = await rpc(chain, 'eth_getLogs', [{ topics: [topic],
          fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        for (const l of logs || []) bucket[l.address.toLowerCase()] = (bucket[l.address.toLowerCase()] || 0) + 1;
      } catch { scanFailed = true; }
    }
  };
  for (let b = Math.max(0, head - recentSpan); b < head; b += window) {
    await scan(b, Math.min(b + window, head), recent);
  }
  await scan(head - window * lookback, head - window * (lookback - 1), old);

  // A partial failure manufactures candidates out of nothing — refuse to nominate on incomplete data.
  if (scanFailed) {
    return {
      experiment: ABANDONED.id,
      aborted: 'one or more log windows failed; "went quiet" is unmeasurable this tick',
      new_candidates: [],
    };
  }

  // Went quiet: paid callers across the last month, silent in the old-window comparison.
  const quiet = Object.keys(old).filter(a => !recent[a]);
  const st = (await env.KV.get('exp:abandoned', 'json')) || { seen: {}, candidates: [] };
  // seen-once must EXPIRE, or a false positive today blocks the real signal forever.
  const fresh = quiet.filter(a => !st.seen[a] || Date.now() - Date.parse(st.seen[a]) > 30 * 864e5).slice(0, 12);
  for (const a of fresh) st.seen[a] = new Date().toISOString();
  st.lastRun = new Date().toISOString();
  st.candidates = [...fresh, ...(st.candidates || [])].slice(0, 60);
  await env.KV.put('exp:abandoned', JSON.stringify(st));

  return {
    experiment: ABANDONED.id, question: ABANDONED.question,
    emitting_now: Object.keys(recent).length,
    emitting_then: Object.keys(old).length,
    went_quiet: quiet.length,
    new_candidates: fresh,
    next_step: fresh.length
      ? 'Run payout_oracle / bruteforce on each. A dead protocol that still pays is the one place the gas-floor equilibrium does not apply.'
      : 'No newly-silent emitters in this window. Widen the lookback or try another chain.',
  };
}

// ── the loop ────────────────────────────────────────────────────────────────
// Rotate so every tick does a different experiment and the whole space keeps getting swept.
// P2-14 FIX: the "narrowing" in this file's header did not exist — selection was unconditional
// round-robin, so an experiment measuring 80% false positives kept half of every tick forever.
// An experiment with N consecutive null/failed runs is benched until config changes, visibly.
const REGISTRY = [
  { id: SKIM.id, run: (env, rpc, chain) => runSkimScan(env, rpc, chain) },
  { id: ABANDONED.id, run: (env, rpc, chain) => runAbandonScan(env, rpc, chain) },
];
const NULL_RUN = (r) => !r || r.unsupported || r.aborted ||
  (/no priced excess|NOT MEASURED/i.test(String(r.conclusion || '')) && !(r.hits?.length));

export async function experimentTick(env, rpc, chain = 'base') {
  const st = (await env.KV.get('exp:meta', 'json')) || { n: 0, log: [] };
  // Prefer an experiment that has not just gone barren; bench any with >=4 consecutive nulls.
  const bench = new Set(Object.entries(st.nullStreak || {}).filter(([, k]) => k >= 4).map(([id]) => id));
  let pool = REGISTRY.filter(r => !bench.has(r.id));
  if (!pool.length) pool = REGISTRY;                    // all benched: keep rotating rather than stop
  const pick = pool[st.n % pool.length];

  let result;
  try { result = await pick.run(env, rpc, chain); }
  catch (e) { result = { experiment: pick.id, error: String(e?.message ?? e).slice(0, 160) }; }
  st.nullStreak = { ...(st.nullStreak || {}) };
  if (NULL_RUN(result)) st.nullStreak[pick.id] = (st.nullStreak[pick.id] || 0) + 1;
  else delete st.nullStreak[pick.id];
  if (bench.has(pick.id) && !pool.some(r => r.id === pick.id)) {
    result.benched_note = `${pick.id} had ${st.nullStreak[pick.id] ?? '>=4'} consecutive nulls and was benched — it ran only because every experiment is currently benched.`;
  } else if (st.nullStreak[pick.id] >= 4) {
    result.benched_note = `${pick.id} now has ${st.nullStreak[pick.id]} consecutive nulls and will be benched from rotation.`;
  }

  // Log EVERY run, negatives included — "we checked and found nothing" is what stops the next run
  // repeating the same slice, and it is the raw material for judging whether a class is worth more.
  st.n = (st.n || 0) + 1;
  st.log = [{ at: new Date().toISOString(), chain, ...result }, ...(st.log || [])].slice(0, 60);
  await env.KV.put('exp:meta', JSON.stringify(st));
  return { tick: st.n, ...result };
}

export async function experimentReport(env) {
  const meta = (await env.KV.get('exp:meta', 'json')) || { n: 0, log: [] };
  const skim = (await env.KV.get('exp:skim', 'json')) || {};
  const aband = (await env.KV.get('exp:abandoned', 'json')) || {};
  return {
    ticks_run: meta.n || 0,
    registry: REGISTRY.map(r => r.id),
    skim: { priced_pairs_checked: skim.checked || 0, best_finds: (skim.found || []).slice(0, 8), cursor: skim.cursor || {} },
    abandoned: { candidates_found: (aband.candidates || []).length, recent: (aband.candidates || []).slice(0, 10) },
    recent_runs: (meta.log || []).slice(0, 8),
    note: 'Negatives are logged deliberately. A class that keeps returning nothing is being eliminated, and elimination is what makes the search converge instead of wander.',
  };
}
