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
  const st = (await env.KV.get('exp:skim', 'json')) || { cursor: {}, checked: 0, found: [] };
  const priced = PRICED[chain] || {};
  const facs = SKIM.factories[chain] || [];
  const list = [];

  for (const f of facs) {
    const cur = st.cursor[f] || 0;
    let len = 0;
    try { len = Number(BigInt(await rpc(chain, 'eth_call', [{ to: f, data: '0x574f2ba3' }, 'latest']))); } catch { continue; }
    if (!len) continue;
    const take = Math.ceil(pairs / facs.length);
    const idx = [];
    for (let k = 0; k < take; k++) idx.push((cur + k) % len);
    st.cursor[f] = (cur + take) % len;                  // walk forever, wrapping
    for (let s = 0; s < idx.length; s += 60) {
      const calls = idx.slice(s, s + 60).map(n => ({ target: f, allowFailure: true,
        callData: '0x1e3dd18b' + n.toString(16).padStart(64, '0') }));
      try {
        for (const r of await agg(rpc, chain, calls)) {
          if (r.success && r.returnData !== '0x') list.push('0x' + r.returnData.slice(26));
        }
      } catch { /* skip the batch */ }
    }
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
    hits: hits.slice(0, 10), best_usd: hits[0]?.usd || 0,
    cursor: st.cursor,
    conclusion: hits.length
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
    Harvest: ethers.id('Harvest(address,uint256)'),
    RewardPaid: ethers.id('RewardPaid(address,uint256)'),
    Compounded: ethers.id('Compounded(uint256,uint256)'),
    Distributed: ethers.id('Distributed(address,uint256)'),
  },
};

export async function runAbandonScan(env, rpc, chain = 'base', { window = 900, lookback = 40 } = {}) {
  const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16);
  const recent = {}, old = {};
  const scan = async (from, to, bucket) => {
    for (const [, topic] of Object.entries(ABANDONED.topics)) {
      try {
        const logs = await rpc(chain, 'eth_getLogs', [{ topics: [topic],
          fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        for (const l of logs || []) bucket[l.address.toLowerCase()] = (bucket[l.address.toLowerCase()] || 0) + 1;
      } catch { /* provider limits vary; a missing window is not fatal */ }
    }
  };
  await scan(head - window, head, recent);
  await scan(head - window * lookback, head - window * (lookback - 1), old);

  // Went quiet: paid callers in the old window, silent in the recent one.
  const quiet = Object.keys(old).filter(a => !recent[a]);
  const st = (await env.KV.get('exp:abandoned', 'json')) || { seen: {}, candidates: [] };
  const fresh = quiet.filter(a => !st.seen[a]).slice(0, 12);
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
const REGISTRY = [
  { id: SKIM.id, run: (env, rpc, chain) => runSkimScan(env, rpc, chain) },
  { id: ABANDONED.id, run: (env, rpc, chain) => runAbandonScan(env, rpc, chain) },
];

export async function experimentTick(env, rpc, chain = 'base') {
  const st = (await env.KV.get('exp:meta', 'json')) || { n: 0, log: [] };
  const pick = REGISTRY[st.n % REGISTRY.length];
  let result;
  try { result = await pick.run(env, rpc, chain); }
  catch (e) { result = { experiment: pick.id, error: String(e.message).slice(0, 160) }; }

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
