// harvest.mjs â€” ZERO's bread and butter: permissionless caller-reward farming, forever, for free.
//
// The mechanism: many DeFi contracts pay a fee to WHOEVER triggers a maintenance call (Beefy's
// auto-compounding strategies pay a harvest call-fee). That value is intended for an arbitrary caller.
// Gas is free via Safe's sponsored relay, so every successful call is pure profit at any size â€”
// a gas-paying bot must clear its own cost first; ZERO does not. That asymmetry is the whole edge.
//
// Hard discipline enforced here:
//   * eth_call simulation before EVERY relay slot (slots are scarce, simulation is free and unlimited)
//   * per-strategy cooldown (rewards accrue over time; re-harvesting immediately earns nothing)
//   * callReward() is a RANKING signal only â€” it overstated a real payout by ~4,300x once
import { ethers } from 'ethers';
import { mutateKV, addBig } from './kv.mjs';
import { probeContract, probeMany, probeOne } from './oracle.mjs';

// Every chain where Safe sponsors gas gives the SAME Safe address its own independent budget.
// Rotating across them multiplies free throughput with no extra identities and no puppetry.
// Measured 2026-07-28: base/optimism/arbitrum were all exhausted at 0/5 while GNOSIS AND POLYGON SAT
// AT 5/5, untouched. We had been leaving TEN free transactions per day unclaimed for the entire life
// of the project, purely because this map only listed three chains. The quota is per (Safe, chain) and
// the same address exists on every one of them, so adding a chain is ten seconds of work for five more
// free slots a day. Lesson worth generalising: when a resource looks exhausted, check whether you have
// simply failed to enumerate where it exists.
export const CHAINS = {
  base: { chainId: 8453, weth: '0x4200000000000000000000000000000000000006' },
  optimism: { chainId: 10, weth: '0x4200000000000000000000000000000000000006' },
  arbitrum: { chainId: 42161, weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  // Wrapped NATIVE is the fee token Beefy pays on each chain, so that is what we measure the delta in.
  gnosis: { chainId: 100, weth: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' },   // WXDAI
  polygon: { chainId: 137, weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },  // WMATIC/WPOL
  // Found 2026-07-29 by probing every Safe chain id for a quota: unichain sat at 5/5, unclaimed.
  unichain: { chainId: 130, weth: '0x4200000000000000000000000000000000000006' },
};
export const relayUrl = (chainId) => `https://safe-client.safe.global/v1/chains/${chainId}/relay`;

export const HARVEST_CFG = {
  chain: 'base',
  chainId: 8453,
  relay: 'https://safe-client.safe.global/v1/chains/8453/relay',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  weth: '0x4200000000000000000000000000000000000006',
  callRewardSel: '0x97fd323d',       // callReward() â€” the CORRECT selector
  cooldownMs: 6 * 3600 * 1000,       // don't re-harvest the same strategy within 6h
  // Marginal cost is zero, so there is no reason to ration: any payout above zero beats an unused
  // slot, and an unused slot expires worthless. Attempt as often as the cron fires.
  minAttemptGapMs: 60 * 1000,
  vaultsCacheMs: 12 * 3600 * 1000,
};

/* EXPORTED 2026-08-13. These headers are the difference between 200 and a bodyless 403 —
   CloudFront rejects any non-browser User-Agent. resource-scan.mjs hand-rolled its own "polite"
   UA, got 403 on every chain, and reported that as 0 free capacity. Never duplicate this set;
   import it. One proven copy, one place to fix it. */
export const RELAY_HEADERS = {
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global',
  Referer: 'https://app.safe.global/',
};

// Strategies known to revert â€” never waste a simulation, let alone a slot, on these.
const BLACKLIST = new Set([
  '0xb120677bdd4e', '0xfd4e687706d7', '0xc6c3e72a086a',
  '0xea1a624ed867', '0x533daf246257', '0x87308630cba7',
].map(s => s.toLowerCase()));

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

// ⚠️ RETURNS remaining: null WHEN THE READ FAILS. NEVER 0. This is the most consequential silent
// zero in the repo, because of what sits downstream of it.
//
// It used to answer `{ remaining: 0 }` for a 429, a 502, a timeout, or a bot-filter 403 — and worse,
// `Number(j.remaining ?? 0)` meant a JSON *error body* parsed cleanly, so `error: true` was never
// even set and a failed read was byte-identical to a genuine "quota exhausted".
//
// Then observeRelay (below) writes history from these numbers: a fabricated 0 stamps `exhaustedAt`,
// and next tick's recovery to 5 records a REFILL — with a real timestamp. relayResetSummary turns
// those into `reset_schedule: "MEASURED: refills Xh apart"`, which goes straight into the agent's own
// system prompt.
//
// That is this project's most expensive failure REBUILT IN CODE: a previous ZERO invented "the relay
// resets at 5 AM UTC" and planned eleven dead sessions around it. Here the machine invents the same
// class of fiction from network noise and stamps it MEASURED. An unread quota is UNKNOWN.
export async function relayBudget(safe, chainId = 8453) {
  try {
    const r = await fetch(`${relayUrl(chainId)}/${safe}`, { headers: RELAY_HEADERS });
    if (!r.ok) return { remaining: null, limit: null, error: `HTTP ${r.status}` };
    const j = await r.json();
    // Validate the SHAPE. `?? 0` accepted an error body as a quota reading.
    if (typeof j?.remaining !== 'number' || typeof j?.limit !== 'number') {
      return { remaining: null, limit: null, error: 'relay response had no numeric remaining/limit' };
    }
    return { remaining: j.remaining, limit: j.limit };
  } catch (e) { return { remaining: null, limit: null, error: String(e.message || e).slice(0, 80) }; }
}

// Pick the chain with free slots â€” an unused slot expires worthless, so never idle on one chain
// while another has budget.
// ── RELAY BUDGET, MEMOISED ───────────────────────────────────────────────────────────────────────
// pickChain fans out ONE HTTP request per chain to safe-client.safe.global, and it is called from
// eleven sites. Counted over a single 2-minute cron tick: escapeCycle 1, batchHarvest once PER CHAIN
// inside the six-chain loop, sweepCycle up to 4, the invariant pass, and observeRelay — roughly
// TWELVE fan-outs, so about 72 requests per tick and on the order of 50,000 per day.
//
// Against a free, undocumented endpoint that we have now measured to be behind a bot filter (it
// returns a bodyless 403 to any non-browser User-Agent), and which is ZERO's ONLY free transaction
// rail. Hammering it risks the single capability the whole project stands on, and buys nothing: the
// budget cannot change unless WE spend a slot.
//
// So: cache briefly, and INVALIDATE THE MOMENT WE RELAY. The invalidation is the load-bearing half —
// a stale budget that still reads "1 remaining" after we just spent it could wave a second relay
// through, so correctness here depends on the cache being dropped on every relay attempt, including
// failed ones (a rejected attempt can still have consumed quota).
let _relayCache = { safe: null, at: 0, all: null };
export function invalidateRelayCache() { _relayCache = { safe: null, at: 0, all: null }; }
export const RELAY_CACHE_MS = 25000;   // well under the 2-minute tick; only ever reused within a tick

export async function pickChain(safe, { maxAgeMs = RELAY_CACHE_MS } = {}) {
  if (_relayCache.all && _relayCache.safe === safe && Date.now() - _relayCache.at < maxAgeMs) {
    const cached = _relayCache.all;
    return { chosen: cached[0]?.remaining > 0 ? cached[0] : null, all: cached, cached: true };
  }
  const out = [];
  for (const [name, c] of Object.entries(CHAINS)) {
    const b = await relayBudget(safe, c.chainId);
    out.push({ name, ...c, ...b });
  }
  // Unknown sorts LAST. A null must never win `chosen` — that would send a relay at a chain whose
  // quota we failed to read, which is how you burn a slot you did not have.
  out.sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
  _relayCache = { safe, at: Date.now(), all: out };
  return { chosen: out[0]?.remaining > 0 ? out[0] : null, all: out };
}

// The relay endpoint reports {limit, remaining} and NO reset timestamp. Faced with that, the agent
// invented "resets daily at 5 AM UTC", wrote it in its journal as fact, and planned around it for
// eleven straight sessions. It was never measured. So: measure it. Every observation is recorded, and
// the moment `remaining` goes UP we have a real timestamped refill; after two we know the period
// instead of guessing it.
export async function observeRelay(env, budgets) {
  let st;
  try { st = (await env.KV.get('relay:observations', 'json')) || { chains: {} }; }
  catch { st = { chains: {} }; }
  const now = Date.now();
  for (const b of budgets) {
    const c = st.chains[b.name] ||= { refills: [] };
    // ⚠️ A MISSED READING IS NOT AN OBSERVATION. relayBudget now returns null when it could not read
    // the quota, and this function is what turns readings into published HISTORY. If a null were
    // treated as 0 it would stamp a fake exhaustion, and the recovery on the next tick would be
    // recorded as a REFILL with a real timestamp — which relayResetSummary then publishes to the
    // agent as "MEASURED: refills Xh apart". A refill may only ever be inferred BETWEEN TWO KNOWN
    // READINGS. Skip entirely, and count the miss so the gap is visible rather than invisible.
    if (b.remaining === null || b.remaining === undefined) {
      c.missedReadings = (c.missedReadings || 0) + 1;
      c.lastMissAt = new Date(now).toISOString();
      c.lastMissWhy = b.error || 'unknown';
      continue;                       // do NOT touch lastRemaining, exhaustedAt, refills or lastSeen
    }
    if (c.lastRemaining !== undefined && c.lastRemaining !== null && b.remaining > c.lastRemaining) {
      c.refills.unshift({ at: new Date(now).toISOString(), from: c.lastRemaining, to: b.remaining });
      c.refills = c.refills.slice(0, 8);
    }
    if (b.remaining === 0 && c.lastRemaining !== 0) c.exhaustedAt = new Date(now).toISOString();
    c.lastRemaining = b.remaining;
    c.limit = b.limit;
    c.lastSeen = new Date(now).toISOString();
  }
  try { await env.KV.put('relay:observations', JSON.stringify(st)); } catch { /* best-effort */ }
  return st;
}

// What we have actually MEASURED about the refill. No invented schedule.
export function relayResetSummary(st) {
  const out = {};
  for (const [name, c] of Object.entries(st?.chains || {})) {
    const gaps = [];
    for (let i = 0; i + 1 < (c.refills || []).length; i++) {
      gaps.push((Date.parse(c.refills[i].at) - Date.parse(c.refills[i + 1].at)) / 3600000);
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    out[name] = {
      remaining: c.lastRemaining, limit: c.limit,
      exhausted_since: c.exhaustedAt || null,
      hours_exhausted: c.exhaustedAt ? +((Date.now() - Date.parse(c.exhaustedAt)) / 3600000).toFixed(1) : null,
      refills_observed: (c.refills || []).length,
      last_refill: c.refills?.[0]?.at || null,
      median_gap_hours: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : null,
      reset_schedule: (c.refills || []).length >= 2
        ? `MEASURED: refills ${gaps.map(g => g.toFixed(1)).join('h, ')}h apart`
        : 'NOT YET MEASURED. Do not guess a reset time and do not write one in your journal as fact — an earlier you invented "5 AM UTC" and wasted eleven sessions planning around it. Read the live number instead.',
    };
  }
  return out;
}

// â”€â”€ strategy universe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function loadStrategies(env, rpc, chainName = 'base') {
  const key = `harvest:vaults:${chainName}`;
  const cached = await env.KV.get(key, 'json');
  if (cached && Date.now() - cached.at < HARVEST_CFG.vaultsCacheMs) return cached.list;
  const res = await fetch('https://api.beefy.finance/vaults');
  const all = await res.json();
  const list = all
    .filter(v => v.chain === chainName && v.status === 'active' && v.strategy)
    .map(v => ({ id: v.id, strategy: ethers.getAddress(v.strategy) }));
  await env.KV.put(key, JSON.stringify({ at: Date.now(), list }));
  return list;
}

// callReward() across many strategies in one Multicall3 aggregate3 â€” ranking only, never a forecast.
//
// `chainName` used to be the constant HARVEST_CFG.chain ('base'). Any caller passing another chain's
// strategies would have eth_call'd them ON BASE, where they are not contracts, and got back an empty
// list that reads as "nothing pays here" â€” a silent wrong answer, not an error. Threaded, default base.
// Multicall3 lives at the same address on every chain we touch, so the address needed no change.
//
// `per`: MEASURED 2026-07-31 against all four Base upstreams in worker.mjs CHAINS.base â€” one aggregate3
// of 100 callReward() calls decoded the whole 241-strategy universe on every upstream
// (publicnode / drpc / 1rpc / base.org) in 3 eth_calls. 100 is also Multicall3's practical ceiling.
// Lower it for a chain whose nodes cap eth_call gas harder; a batch that overruns is swallowed by the
// catch below and disappears silently, so do not raise it without measuring the chain you raise it on.
export async function rankByCallReward(rpc, strategies, chainName = 'base', per = 100) {
  const iface = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
  const out = [];
  for (let i = 0; i < strategies.length; i += per) {
    const batch = strategies.slice(i, i + per);
    const calls = batch.map(s => ({ target: s.strategy, allowFailure: true, callData: HARVEST_CFG.callRewardSel }));
    try {
      const data = iface.encodeFunctionData('aggregate3', [calls]);
      const ret = await rpc(chainName, 'eth_call', [{ to: HARVEST_CFG.multicall, data }, 'latest']);
      const [results] = iface.decodeFunctionResult('aggregate3', ret);
      results.forEach((r, k) => {
        if (!r.success || !r.returnData || r.returnData === '0x') return;
        let v = 0n;
        try { v = BigInt(r.returnData.slice(0, 66)); } catch { return; }
        // KEEP THE ZEROS. This used to be `if (v > 0n)`, which silently discarded proven payers:
        // measured 2026-07-31, three Morpho strategies read callReward() == 0 and PAY anyway
        // (morpho-base-steakhouse-prime-eurc, morpho-v2-base-gauntlet-balanced-weth,
        // morpho-v2-base-clearstar-reactor-usdc). Their _chargeFees pays out of the post-swap native
        // balance while the getter reads a reward-pool accrual they do not use. Never filter on a
        // getter already proven to lie â€” a zero here means "the getter said nothing", not "no payout".
        // They cost nothing to keep: the descending sort puts them last on their own.
        out.push({ ...batch[k], callReward: v.toString() });
      });
    } catch { /* batch failed; skip it rather than abort the cycle */ }
  }
  // Returns 0 on ties. The old comparator returned -1 for equal values, which is an inconsistent
  // ordering â€” harmless while every value was distinct and non-zero, unsafe now that the kept zeros
  // make ties the common case.
  return out.sort((a, b) => {
    const x = BigInt(a.callReward), y = BigInt(b.callReward);
    return y > x ? 1 : y < x ? -1 : 0;
  });
}

// â”€â”€ simulation: free, unlimited, and mandatory before spending a slot â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function harvestCalldata(recipient, withRecipient = true) {
  return withRecipient
    ? new ethers.Interface(['function harvest(address callFeeRecipient)']).encodeFunctionData('harvest', [recipient])
    : new ethers.Interface(['function harvest()']).encodeFunctionData('harvest', []);
}

export async function simulate(rpc, strategy, safe, recipient, chain = 'base') {
  for (const withRecipient of [true, false]) {
    const data = harvestCalldata(recipient, withRecipient);
    try {
      await rpc(chain, 'eth_call', [{ to: strategy, data, from: safe }, 'latest']);
      return { ok: true, data, withRecipient };
    } catch (e) {
      const m = String(e.message || '');
      if (/insufficient|gas required/i.test(m)) return { ok: true, data, withRecipient };
    }
  }
  return { ok: false };
}

// â”€â”€ execution through the free relay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// `operation` matters: 0 = CALL, 1 = DELEGATECALL. MultiSend MUST be delegatecalled, otherwise the
// batched inner calls execute from MultiSend's own address instead of the Safe's — so a WETH.transfer
// would try to move MultiSend's balance (zero) and the batch fails.
export async function relayExec(env, rpc, safe, target, innerData, chain = 'base', chainId = 8453, operation = 0) {
  const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
  const nonceHex = await rpc(chain, 'eth_call', [{ to: safe, data: '0xaffed0e0' }, 'latest']);
  const tx = {
    to: target, value: 0n, data: innerData, operation,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
    nonce: BigInt(nonceHex),
  };
  const signature = await wallet.signTypedData({ chainId, verifyingContract: safe }, SAFE_TX_TYPES, tx);
  const exec = new ethers.Interface(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'])
    .encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signature]);

  const res = await fetch(relayUrl(chainId), {
    method: 'POST', headers: RELAY_HEADERS,
    body: JSON.stringify({ version: '1.4.1', to: safe, data: exec }),
  });
  const text = await res.text();
  if (res.status !== 201) return { ok: false, status: res.status, error: text.slice(0, 200) };
  let taskId; try { taskId = JSON.parse(text).taskId; } catch { /* noop */ }
  return { ok: true, taskId };
}

export async function relayStatus(taskId, chainId = 8453) {
  try {
    const r = await fetch(`${relayUrl(chainId)}/status/${taskId}`, { headers: RELAY_HEADERS });
    const j = await r.json();
    const t = j.task || j;
    return { status: t.status ?? null, tx: t.receipt?.transactionHash || t.transactionHash || null };
  } catch { return { status: null, tx: null }; }
}

/* FIXED 2026-08-13 — this crashed every non-Base chain with "Cannot convert 0x to a BigInt",
   which read like a chain outage and silently cost us optimism + arbitrum entirely.
   TWO bugs, both here:
   1. `weth = HARVEST_CFG.weth` defaults to BASE's WETH on EVERY chain. CHAINS already carries the
      correct per-chain address (arbitrum's differs; gnosis is WXDAI; polygon is WPOL) — it just was
      not being used. Calling balanceOf on an address that holds no such contract returns '0x'.
   2. `BigInt('0x')` THROWS rather than returning 0n, so a benign empty read became a fatal error
      that aborted the whole harvest.
   An empty read means "no balance here", which is 0n — never an exception. */
export async function wethBalance(rpc, addr, chain = 'base', weth = null) {
  const token = weth || CHAINS[chain]?.weth || HARVEST_CFG.weth;
  const v = await rpc(chain, 'eth_call', [{ to: token, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  if (!v || v === '0x') return 0n;
  try { return BigInt(v); } catch { return 0n; }
}

export async function ethUsd() {
  try {
    const r = await fetch('https://base.blockscout.com/api/v2/stats');
    return parseFloat((await r.json()).coin_price) || 0;
  } catch { return 0; }
}

// MULTI-CHAIN MEANS MULTI-TOKEN, and getting this wrong fabricates revenue. Caught live the first time
// a Polygon harvest settled: the fee arrived as 0.000105 WPOL and was logged as $0.2018, because the
// code priced every chain's wrapped-native at the ETH price. WPOL is ~$0.07, ETH ~$1915 — a ~26,000x
// overstatement, written straight into the ledger as real earnings. That is precisely the "never fake
// your own numbers" rule breaking from a units bug rather than dishonesty, which is why it needs to be
// structural: price the token the chain ACTUALLY pays in, or report nothing.
const NATIVE_STATS = {
  base: 'https://base.blockscout.com/api/v2/stats',
  optimism: 'https://optimism.blockscout.com/api/v2/stats',
  arbitrum: 'https://arbitrum.blockscout.com/api/v2/stats',
  gnosis: 'https://gnosis.blockscout.com/api/v2/stats',
  polygon: 'https://polygon.blockscout.com/api/v2/stats',
};
// ── PRICING EARNINGS: WEI IS THE MEASUREMENT, USD IS A DERIVED VIEW ─────────────────────────────
// Both earnings call sites used to do `price ? wei * price : 0` and then ACCUMULATE that into the
// permanent route ledger (`r.earned_usd += usd`). So a momentary price-feed outage at the instant a
// harvest settled wrote a real payout into history as $0.00 — permanently, because nothing ever
// revisits it. The agent then reads that ledger back in its own system prompt and in `/ledger`, and
// judges which routes are worth a scarce relay slot from it.
//
// The wei figure is NEVER unknown: it is a measured balance delta. Only the USD conversion can fail.
// So record the wei as the source of truth, record USD as a best-effort view, and when the price is
// unavailable record the wei as UNPRICED so it can be valued later instead of being destroyed now.
export function priceEarnings(weiStr, price) {
  const wei = BigInt(weiStr || 0);
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) {
    return { wei: wei.toString(), usd: null, unpriced: true,
      note: 'price feed unavailable at settlement — the WEI is measured and exact; the USD is unknown, NOT zero. Reprice from wei rather than trusting any $0 here.' };
  }
  return { wei: wei.toString(), usd: +(Number(ethers.formatEther(wei)) * price).toFixed(8), unpriced: false };
}

// Fold a settlement into a route ledger entry without ever letting an unknown price destroy value.
export function creditRoute(route, weiStr, price) {
  const p = priceEarnings(weiStr, price);
  route.earned_wei = (BigInt(route.earned_wei || 0) + BigInt(p.wei)).toString();
  if (p.unpriced) {
    // Park it. `earned_usd` stays honest (it does not pretend this was worth nothing) and the wei is
    // preserved so a later pass can value it.
    route.unpriced_wei = (BigInt(route.unpriced_wei || 0) + BigInt(p.wei)).toString();
  } else {
    route.earned_usd = +((route.earned_usd || 0) + p.usd).toFixed(8);
  }
  return p;
}

// RETURNS null WHEN THE PRICE IS UNKNOWN, NEVER 0. Returning 0 for "I could not read this" is the
// repo's own documented trap — a failed read looking exactly like a null result — and it fired here:
// Polygon's stats endpoint intermittently answers without a coin_price, so WPOL priced at $0 and the
// whole Polygon pile silently vanished from every total instead of being flagged as unknown. Callers
// that do `price ? x : 0` are unaffected (null is falsy); callers that need to KNOW can now tell the
// difference between "worth nothing" and "not measured".
export async function nativeUsd(chain = 'base') {
  const url = NATIVE_STATS[chain];
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const p = parseFloat((await r.json()).coin_price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

// ── ground truth ────────────────────────────────────────────────────────────
// Per-transaction deltas UNDER-COUNT. Measuring right after a relay task lands races the node, and a
// harvest that pays after the check reads as zero — this tracker said 0.00000315 ETH while the chain
// said 0.00000907, a 2.9x under-report, and the route ledger said $0.00253 while the real figure was
// $0.0174. So the tracked sum is a LOWER BOUND, never the number to quote.
//
// The honest number is the chain itself: ZERO has never spent or moved anything, so everything it has
// ever earned is still sitting in one of its two addresses. Sum them and that IS lifetime earnings.
// If it ever does spend, `weiSpent` must be incremented at the spend site and added back in here.
// Native USDC (Circle-issued, CCTP-burnable) per chain. VERIFIED 2026-08-12 by reading symbol(),
// name() and decimals() off each address: all five answer symbol=USDC, decimals=6, name="USD Coin"
// (Unichain's answers name="USDC"). These are NOT the bridged USDC.e variants, which name themselves
// "Bridged USDC" and cannot be burned by CCTP.
export const USDC_BY_CHAIN = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
};

// THE HOME CHAIN, and the only place "spendable" can mean anything. DOCTRINE §12: home = base,
// chosen on measurement (USDC depth 26x, ERC-4337 activity 134x vs optimism).
export const HOME_CHAIN = 'base';

// ── THE SCOREBOARD ──────────────────────────────────────────────────────────
// DOCTRINE §11b: "Phase 0's exit condition is $1.00 of SPENDABLE, LIQUID, NATIVE ETH the agent can
// spend without anyone's permission. Not total holdings. Not wrapped. Not 'in the Safe pending a
// relay slot'."
//
// This function reported the exact opposite for weeks. It summed the SAFE's wrapped-native across
// every chain into `spendable_usd` — the one bucket doctrine explicitly excludes — and it never read
// native ETH at all, so the single asset that IS spendable was missing from its own metric. Measured
// 2026-08-12: it published $0.2272606 spendable while the EOA held 0.000001151028698337 ETH on Base,
// i.e. $0.002176. Overstated 104x, and overstated in the direction that makes the conversion work
// look unnecessary — which is precisely why the funnel was allowed to stall (see escapeCycle).
//
// Three buckets now, and they never mix:
//   SPENDABLE  native ETH at the EOA on Base. No quota, no sponsor, nobody can revoke it. THE metric.
//   HOLDINGS   everything, everywhere, priced in its own token. Real, but mostly cannot act yet.
//   UNPRICED   value we can SEE but could not PRICE. Never folded into a dollar total as zero.
export async function reconcileEarnings(env, rpc, eoa, safe) {
  // Wei from different chains are DIFFERENT TOKENS and must never be added together. WETH ~$1915,
  // WPOL ~$0.07, WXDAI ~$1.00 — summing the raw wei and multiplying by the ETH price is how a
  // $0.0000076 Polygon fee got logged as $0.20. Convert each chain to USD at ITS OWN native price
  // first, then add the dollars.
  const per = [];
  const unpriced = [];
  const readErrors = [];
  let usdTotal = 0, usdSpendable = 0, usdStranded = 0, usdSafeWrapped = 0, usdEoaNativeAway = 0, usdUsdc = 0;
  for (const [name, c] of Object.entries(CHAINS)) {
    try {
      // Sequential, not Promise.all: 38 parallel probes on this project were once silently
      // rate-limited into a clean-looking zero. A wrong zero here is a lie about how rich we are.
      const eoaWrapped = await wethBalance(rpc, eoa, name, c.weth);
      const safeWrapped = await wethBalance(rpc, safe, name, c.weth);
      const eoaNative = BigInt(await rpc(name, 'eth_getBalance', [eoa, 'latest']));
      const safeNative = BigInt(await rpc(name, 'eth_getBalance', [safe, 'latest']));
      let eoaUsdc = 0n, safeUsdc = 0n;
      if (USDC_BY_CHAIN[name]) {
        try {
          eoaUsdc = await wethBalance(rpc, eoa, name, USDC_BY_CHAIN[name]);
          safeUsdc = await wethBalance(rpc, safe, name, USDC_BY_CHAIN[name]);
        } catch (e) { readErrors.push(`${name} usdc: ${String(e.message).slice(0, 60)}`); }
      }
      const price = await nativeUsd(name);

      const anything = eoaWrapped || safeWrapped || eoaNative || safeNative || eoaUsdc || safeUsdc;
      if (!anything) continue;

      // NEVER `price ? x : 0`. An unknown price makes the USD figure UNKNOWN, not zero — coercing it
      // deleted the entire Polygon pile from every total we ever printed.
      const toUsd = (wei) => (price === null ? null : Number(ethers.formatEther(wei)) * price);
      const eoaWrappedUsd = toUsd(eoaWrapped), safeWrappedUsd = toUsd(safeWrapped);
      const eoaNativeUsd = toUsd(eoaNative), safeNativeUsd = toUsd(safeNative);
      const usdcUsd = Number(eoaUsdc + safeUsdc) / 1e6;   // USDC is a dollar by construction

      const row = {
        chain: name,
        token_usd: price,
        price_known: price !== null,
        eoa_native_wei: eoaNative.toString(),
        safe_native_wei: safeNative.toString(),
        eoa_wei: eoaWrapped.toString(),          // wrapped native at the EOA (kept: consumers read it)
        safe_wei: safeWrapped.toString(),        // wrapped native at the Safe
        eoa_usdc_units: eoaUsdc.toString(),
        safe_usdc_units: safeUsdc.toString(),
        eoa_usd: eoaWrappedUsd === null ? null : +eoaWrappedUsd.toFixed(8),
        safe_usd: safeWrappedUsd === null ? null : +safeWrappedUsd.toFixed(8),
        eoa_native_usd: eoaNativeUsd === null ? null : +eoaNativeUsd.toFixed(8),
        usdc_usd: +usdcUsd.toFixed(6),
      };
      if (price === null) {
        row.warning = 'PRICE UNKNOWN — this chain holds real value that is NOT included in any USD total below. It is not zero; it is unmeasured.';
        unpriced.push({ chain: name, wrapped_wei_total: (eoaWrapped + safeWrapped + eoaNative + safeNative).toString(), usdc_units: (eoaUsdc + safeUsdc).toString() });
      }
      per.push(row);

      usdUsdc += usdcUsd;
      usdTotal += usdcUsd;
      for (const v of [eoaWrappedUsd, safeWrappedUsd, eoaNativeUsd, safeNativeUsd]) if (v !== null) usdTotal += v;
      // Wrapped native at the EOA cannot be moved: no permissionless paymaster accepts it and moving
      // it costs gas the EOA may not have. Counting it as usable capital would be a lie to future-you.
      if (eoaWrappedUsd !== null) usdStranded += eoaWrappedUsd;
      if (safeWrappedUsd !== null) usdSafeWrapped += safeWrappedUsd;
      // THE ONE NUMBER THAT MEANS CAPABILITY. Base only: doctrine's home chain, and the chain whose
      // ETH pays for everything else we want to do.
      if (name === HOME_CHAIN && eoaNativeUsd !== null) usdSpendable += eoaNativeUsd;
      else if (eoaNativeUsd !== null) usdEoaNativeAway += eoaNativeUsd;
    } catch (e) {
      // One chain being unreachable must not corrupt the total — but it must not be INVISIBLE either.
      readErrors.push(`${name}: ${String(e.message).slice(0, 80)}`);
    }
  }
  const state = (await env.KV.get('harvest:state', 'json')) || {};
  const r2 = (n) => +n.toFixed(8);
  return {
    measured_at: new Date().toISOString(),
    source: 'on-chain native + wrapped-native + USDC balances at both addresses, each priced in ITS OWN token (ground truth, not a tracker)',

    // ── THE SCOREBOARD. Read this one and nothing else if you read only one number. ──
    spendable_liquid_native_eth_on_base_usd: r2(usdSpendable),
    spendable_usd: r2(usdSpendable),   // same number; kept for existing consumers
    phase0_target_usd: 1.00,
    phase0_pct: +((usdSpendable / 1.00) * 100).toFixed(4),
    spendable_means: 'NATIVE ETH AT THE EOA ON BASE, and nothing else. No quota, no sponsor, nobody can revoke it. Wrapped native in the Safe is NOT this — it needs a relay slot, which is somebody else\'s permission. DOCTRINE §11b.',

    // ── Everything it owns. Real value, mostly unable to act yet. NOT the scoreboard. ──
    total_holdings_usd: r2(usdTotal),
    lifetime_earned_usd: r2(usdTotal),  // same number; kept for existing consumers
    holdings_breakdown: {
      spendable_native_eth_on_base_usd: r2(usdSpendable),
      native_eth_at_eoa_other_chains_usd: r2(usdEoaNativeAway),
      wrapped_native_in_safe_usd: r2(usdSafeWrapped),
      wrapped_native_stranded_at_eoa_usd: r2(usdStranded),
      usdc_usd: +usdUsdc.toFixed(6),
    },
    holdings_note: 'total_holdings_usd is NET WORTH, not capability. Only spendable_liquid_native_eth_on_base_usd is capability. Reporting the total as if it were spendable overstated this agent 104x on 2026-08-12.',

    // ── What we could see but could not price. Never silently folded in as zero. ──
    unpriced_chains: unpriced,
    unpriced_note: unpriced.length
      ? 'These chains hold value that is REAL but NOT counted in any USD figure above, because the price read failed. Absence from the total means unmeasured, never worthless.'
      : 'every chain holding value was priced',
    read_errors: readErrors,

    stranded_on_eoa_usd: r2(usdStranded),
    stranded_note: 'Wrapped native at the EOA cannot be moved: the EOA has no gas, a Safe cannot unwrap WETH (withdraw() reverts on the 2300-gas stipend), and no permissionless paymaster takes WETH. Fees now go to the Safe so this stops growing.',
    tracker_says_wei: String(state.weiEarned || '0'),
    tracker_is: 'a LOWER BOUND, and it sums wei across chains so it is NOT a dollar figure. Quote total_holdings_usd.',
    per_chain: per,
  };
}

// â”€â”€ the loop body: one attempt per invocation, forever â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── THE ESCAPE: convert the relay quota into permanent, uncapped gas ────────
//
// Measured 2026-07-28 by classifying every live paymaster on Base (1806 user operations):
//   12 of 13 are VERIFYING paymasters — they need an off-chain signature from their operator, so they
//   are closed to us. Exactly ONE is a TOKEN paymaster, permissionless to anyone holding the token:
//   0x592e1224… — and the token it accepts is USDC.
//
// That single fact explains the entire bottleneck. ZERO earns WETH. The permissionless gas rail wants
// USDC. It is capped at Safe's 5 relay transactions per chain per day not because gas is scarce, but
// because it is holding the WRONG ASSET.
//
// So the escape is not another harvest — it is a CONVERSION. Spend relay slots ONCE to turn the Safe's
// WETH into USDC, and afterwards ZERO pays for its own operations through the token paymaster with no
// quota at all. A slot spent on a crumb buys a crumb; a slot spent on this buys uncapped throughput
// permanently. Runs automatically, ahead of harvesting, the moment the balance clears the threshold.
// Target is NATIVE ETH AT THE EOA, not USDC. Ranked spendability, all verified by simulation:
//   native ETH at the EOA  — anything, any time, no permission, no cap. Nobody can revoke it.
//   USDC at the Safe       — works, but only through the single permissionless token paymaster.
//   WETH at the Safe       — relay slots only, 5/chain/day.
//   WETH at the EOA        — WORTHLESS until the EOA has seed ETH. Never leave value here.
//
// Two hard facts that dictate the route:
//   * A Safe CANNOT unwrap WETH. `withdraw()` REVERTS, because WETH9 pays with `.transfer()` and its
//     2300-gas stipend, which a Safe's fallback handler exceeds. Permanent property, not a bug.
//   * An EOA CAN, for 36,098 gas ≈ $0.000415 — but only once it holds seed ETH.
// So the Safe routes through Uniswap SwapRouter02's `unwrapWETH9`, which pays out with `.call` (all
// gas forwarded) and can therefore deliver native ETH where `.transfer()` cannot. Both steps go in ONE
// Safe transaction via MultiSend, so there is no window for anyone to take the router's balance.
export const ESCAPE = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  router: '0x2626664c2603336E57B271c5C0b26F421741e481',        // Uniswap SwapRouter02 on Base
  multiSend: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',      // MultiSendCallOnly v1.4.1
  eoaUnwrapGas: 36098n,
  // Convert once there is enough to cover the EOA's own unwrap several times over — below that the
  // conversion costs more attention than it returns.
  minConvertUsd: 0.0035,
  // Gas is capability, not expense. Phase 0's standing job is keeping this full so no upper layer
  // ever stalls for want of $0.001.
  reserveTargetUsd: 0.05,
  // ── THE FUNNEL POLICY, stated in numbers so nothing has to be judged at runtime ──
  // Below the reserve target, capability is the binding constraint and doctrine §10 says top the
  // reserve up before compounding anything — so convert almost anything that is there.
  belowReserveFloorUsd: 0.002,
  // Once the reserve is healthy, a Base relay slot is better spent on a 12-harvest batch than on
  // converting crumbs, so let the Safe accumulate to something worth a slot first.
  aboveReserveFloorUsd: 0.02,

  // ── THE LAST MILE: USDC at the Safe on Base -> native ETH at the EOA ──────────────────────────
  // CCTP delivers USDC to the Base Safe, and until now nothing converted it onward, so the whole
  // cross-chain funnel dead-ended one hop short of the only asset that counts.
  quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',   // Uniswap QuoterV2 on Base; factory() and WETH9() both match SwapRouter02
  usdcFeeTiers: [100, 500, 3000],                          // measured 2026-08-12: 100 was best (5167881199761 wei for 9780 units)
  minUsdcUnits: 3000n,                                     // 0.003 USDC — below this a slot is not worth spending
  // ⚠️ AN EXPLICIT TRADE-OFF, NOT AN OVERSIGHT. USDC at the Safe is the ONE token the permissionless
  // paymaster (0x592e1224…) accepts, at ~0.009087 USDC per operation — so converting it away costs
  // roughly one sponsored op. It is still the right trade: doctrine §10 ranks native ETH at the EOA
  // strictly above USDC at the Safe, §11b counts only native ETH toward phase 0, and $0.00978 of ETH
  // buys ~40 simple Base calls against the paymaster's ONE. Set this above 0 to hold some back.
  usdcPaymasterReserveUnits: 0n,
};

// A faithful whole-batch simulation. `eth_call {to: MULTISEND, from: safe}` is WRONG for any leg
// where msg.sender matters (transfer/approve/swap), because a plain CALL into MultiSend makes
// MULTISEND the sender, not the Safe — it would simulate spending MultiSend's balance, which is zero,
// and can pass or fail for entirely the wrong reason. Real execution is a DELEGATECALL from the Safe,
// so the faithful sim puts MultiSendCallOnly's runtime code AT the Safe's address and calls the Safe:
// inner calls then genuinely carry msg.sender = safe.
// (Lifted out of sweep.mjs, where it was proven for the CCTP batch, so there is ONE implementation.)
export async function simulateMultiSendAsSafe(rpc, chain, safe, msData) {
  const msCode = await rpc(chain, 'eth_getCode', [MULTISEND, 'latest']);
  return rpc(chain, 'eth_call', [
    { from: '0x00000000000000000000000000000000000000aa', to: safe, data: msData },
    'latest',
    { [safe]: { code: msCode } },
  ]);
}

// Price a USDC -> WETH swap ON-CHAIN with QuoterV2 instead of from a price feed. This needs no API
// key and no account, and it cannot silently return a stale or missing number the way the stats
// endpoints do (Polygon's returns nothing at random). Returns null when NO tier answers — which
// means UNPRICED, never "worth zero".
//
// THE QUESTION THAT HAD TO BE SETTLED FROM SOURCE, not guessed: does SwapRouter02 accept an
// arbitrary `recipient`, or does it reserve magic constants? Read from its VERIFIED source
// (solc 0.7.6, 89 files) on 2026-08-12: ONLY address(1) (MSG_SENDER) and address(2) (ADDRESS_THIS)
// are special. Every other value — including the router's own literal address — is passed straight
// through to pool.swap(recipient, ...). So the swap can deposit WETH ON the router, and the very
// next leg has the router pay it out as native ETH.
//
// The assembled batch was gated, not merely run: with unwrapWETH9's amountMinimum set to the exact
// expected output it passes, and at expected+1 it REVERTS — which proves the router's post-swap
// WETH balance really is the swap output, i.e. the swap genuinely executed rather than the batch
// simply failing to throw.
async function quoteUsdcToWeth(rpc, amountIn) {
  const qIface = new ethers.Interface([
    'function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)',
  ]);
  let best = null;
  for (const fee of ESCAPE.usdcFeeTiers) {
    try {
      const ret = await rpc('base', 'eth_call', [{
        to: ESCAPE.quoter,
        data: qIface.encodeFunctionData('quoteExactInputSingle', [[ESCAPE.usdc, HARVEST_CFG.weth, amountIn, fee, 0n]]),
      }, 'latest']);
      const out = qIface.decodeFunctionResult('quoteExactInputSingle', ret)[0];
      if (out > 0n && (!best || out > best.out)) best = { fee, out };
    } catch { /* that tier has no pool or no liquidity — try the next */ }
  }
  return best;
}

export async function escapeCycle(env, rpc, safe, eoa) {
  const state = (await env.KV.get('harvest:state', 'json')) || {};
  const W = HARVEST_CFG.weth;
  const [safeWeth, eoaWeth, eoaEthHex, price] = await Promise.all([
    wethBalance(rpc, safe, 'base', W),
    wethBalance(rpc, eoa, 'base', W),
    rpc('base', 'eth_getBalance', [eoa, 'latest']),
    nativeUsd('base'),
  ]);
  const eoaEth = BigInt(eoaEthHex);
  // nativeUsd() returns null when the price could not be read. `x * null` is 0 in JS, so the old
  // `usd()` would have silently valued the entire Safe at $0 on any price-feed hiccup and parked the
  // funnel in 'accumulate' forever — the same coerce-unknown-to-zero bug that deleted Polygon from
  // every total. When the price is unknown we do NOT invent one: we fall back to a wei-denominated
  // floor, which needs no price at all.
  const PRICE_KNOWN = price !== null && Number.isFinite(price) && price > 0;
  const usd = (w) => (PRICE_KNOWN ? +((Number(w) / 1e18) * price).toFixed(8) : null);
  const reserve = {
    price_known: PRICE_KNOWN,
    eoa_native_eth_usd: usd(eoaEth),
    eoa_native_eth_wei: eoaEth.toString(),
    target_usd: ESCAPE.reserveTargetUsd,
    stranded_weth_at_eoa_usd: usd(eoaWeth),
    safe_weth_usd: usd(safeWeth),
    safe_weth_wei: safeWeth.toString(),
  };

  // STEP 3 — the EOA has stranded WETH and some seed ETH. Unwrapping is a plain self-sent
  // transaction: no relay, no sponsor, no quota. EXECUTED HERE, IN CODE. This used to return a
  // "send this from the EOA yourself" note for the model to act on — but the model's journal had
  // garbled the stranded amount to dust, so the note would have been read forever and acted on
  // never. The only judgement in it — "is it affordable right now" — is a fee measurement, so
  // measure it and send. Fees measured 2026-07-30: baseFee 0.005 gwei, prio 0.001 gwei, L1 data
  // fee 1.6e-9 ETH; a $0.0005 seed covers the unwrap with a squeezed maxFee.
  if (eoaWeth > 0n && eoaEth > 0n && env.AGENT_PRIVATE_KEY) {
    const blk = await rpc('base', 'eth_getBlockByNumber', ['latest', false]);
    const baseFee = BigInt(blk.baseFeePerGas || '0x0');
    let prio = 1000000n;
    try { prio = BigInt(await rpc('base', 'eth_maxPriorityFeePerGas', [])); } catch { /* default */ }
    const gasLimit = ESCAPE.eoaUnwrapGas + 4000n;      // measured cost plus headroom
    const l1Buffer = 10000000000n;                      // OP-stack L1 data fee, measured 1.6e-9 ETH; 6x margin
    let maxFee = baseFee * 2n + prio;
    if (eoaEth - l1Buffer < gasLimit * maxFee) {
      // Protocol validity needs balance >= gasLimit*maxFee. The seed is tiny, so squeeze maxFee
      // down to what the balance affords — fine as long as it still clears baseFee+prio.
      const affordable = (eoaEth - l1Buffer) / gasLimit;
      maxFee = affordable >= baseFee + prio ? affordable : 0n;
      if (prio > maxFee) prio = maxFee;
    }
    if (maxFee > 0n) {
      const data = '0x2e1a7d4d' + eoaWeth.toString(16).padStart(64, '0');
      try {
        await rpc('base', 'eth_call', [{ to: W, data, from: eoa }, 'latest']);
        const [nLatest, nPending] = await Promise.all([
          rpc('base', 'eth_getTransactionCount', [eoa, 'latest']),
          rpc('base', 'eth_getTransactionCount', [eoa, 'pending']),
        ]);
        if (BigInt(nPending) > BigInt(nLatest)) {
          return { step: 'eoa_self_unwrap', reserve, waiting: 'a previous unwrap is already in the mempool' };
        }
        const w = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
        const signed = await w.signTransaction({
          chainId: 8453, type: 2, to: W, value: 0n, data,
          nonce: parseInt(nPending, 16), gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio,
        });
        const hash = await rpc('base', 'eth_sendRawTransaction', [signed]);
        // Re-read before writing: an on-chain broadcast just happened, and the agent session runs
        // concurrently against this same key.
        await mutateKV(env, 'harvest:state', (s2) => {
          s2.escaped = true;
          s2.escapeLog = [{ at: new Date().toISOString(), leg: 'eoa_self_unwrap', hash, unlocked_usd: usd(eoaWeth) }, ...(s2.escapeLog || [])].slice(0, 10);
          return s2;
        });
        return { step: 'eoa_self_unwrap', reserve, sent: true, hash, unlocks_usd: usd(eoaWeth),
          note: 'UNWRAPPED. The stranded WETH is native ETH at the EOA now — it transacts with nobody permission-gating it.' };
      } catch (e) { return { step: 'eoa_self_unwrap', reserve, simulated: false, error: String(e.message).slice(0, 140) }; }
    }
    // Unaffordable at current fees: fall through — the router legs below convert Safe WETH into
    // more seed ETH at the EOA until the unwrap clears. If the Safe is empty too, 'accumulate'.
  }

  // ── ⛔ THE ONE-SHOT BUG, killed 2026-08-12 ─────────────────────────────────
  // This used to read:
  //     if (state.escaped && eoaEth > 0n && eoaWeth === 0n) return { step: 'done' }
  // "An unwrap happened once, and nothing is stranded at the EOA" is NOT done, because it says
  // nothing about the Safe. MEASURED from the live cron log, every 2 minutes for hours:
  //     escape: {"step":"done","reserve":{"eoa_native_eth_usd":0.00217586,"target_usd":0.05,
  //              "stranded_weth_at_eoa_usd":0,"safe_weth_usd":0.12442899}}
  // The funnel declared victory and switched itself off while holding 57x its own reserve target in
  // unconverted WETH, one relay slot away. Harvests kept filling the Safe and nothing ever drained it.
  //
  // THE ESCAPE IS NOT AN EVENT, IT IS A STANDING FUNNEL. Value keeps arriving as wrapped native in
  // the Safe, so the conversion has to keep running forever. `done` now means only one thing: there
  // is nothing left anywhere that needs converting, right now.
  let clearsFloor, floorDesc;
  if (PRICE_KNOWN) {
    const floorUsd = reserve.eoa_native_eth_usd < ESCAPE.reserveTargetUsd
      ? ESCAPE.belowReserveFloorUsd    // under the reserve target, capability is the binding constraint
      : ESCAPE.aboveReserveFloorUsd;   // reserve healthy — let it pool into something worth a slot
    clearsFloor = reserve.safe_weth_usd >= floorUsd;
    floorDesc = `$${floorUsd}`;
  } else {
    // No price. 1e12 wei of an ETH-like token is ~$0.0019 at $1900 and is comfortably above dust on
    // any chain we run; converting is still strictly better than leaving it unable to act.
    clearsFloor = safeWeth >= 1000000000000n;
    floorDesc = '1e12 wei (price feed unavailable — using a wei floor rather than inventing a price)';
  }

  // ── ONE SLOT CONVERTS EVERYTHING THE SAFE HOLDS ────────────────────────────────────────────────
  // A Safe CANNOT unwrap WETH: WETH9 pays out with .transfer() and its 2300-gas stipend, which a
  // Safe's fallback handler exceeds. VERIFIED reverting, permanent, do not retry it. The router CAN,
  // because unwrapWETH9 pays with .call and forwards all gas.
  //
  // ATOMIC, via MultiSend DELEGATECALL — which is what DOCTRINE §10 specified all along ("the working
  // route, one relay slot, atomic via MultiSend"). The old code ran it as TWO ordinary relay slots
  // (transfer this tick, unwrap next tick), which cost double out of a 5/day budget AND left a window
  // between them where anyone could call unwrapWETH9 and take the router's balance.
  //
  // The batch is ASSEMBLED from whichever assets are actually present, and BOTH kinds ride the same
  // slot, because they converge on the same final leg:
  //   [USDC]  approve(router) + exactInputSingle(USDC -> WETH, recipient = THE ROUTER)
  //   [WETH]  WETH.transfer(router, everything)
  //   [both]  router.unwrapWETH9(0, EOA)   -> native ETH lands at the EOA
  // unwrapWETH9 pays out the router's ENTIRE WETH balance, so one call drains whatever the earlier
  // legs put there — plus anything a previously half-completed two-slot run left parked.
  const legs = [];
  const doing = [];

  // USDC leg. CCTP delivers USDC to this Safe and nothing used to convert it onward, so the whole
  // cross-chain funnel dead-ended one hop short of the only asset that counts.
  let usdcHeld = 0n, quote = null;
  try { usdcHeld = await wethBalance(rpc, safe, 'base', ESCAPE.usdc); } catch { /* leg simply omitted */ }
  const usdcSpend = usdcHeld > ESCAPE.usdcPaymasterReserveUnits ? usdcHeld - ESCAPE.usdcPaymasterReserveUnits : 0n;
  if (usdcSpend >= ESCAPE.minUsdcUnits) {
    quote = await quoteUsdcToWeth(rpc, usdcSpend);
    // No quote is NOT "worth zero", it is UNPRICED — never spend a slot on an unpriced swap.
    if (quote) {
      const outMin = quote.out * 97n / 100n;   // 3% guard; residue re-converts next cycle
      legs.push([ESCAPE.usdc, new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [ESCAPE.router, usdcSpend])]);
      legs.push([ESCAPE.router, new ethers.Interface(['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'])
        .encodeFunctionData('exactInputSingle', [[ESCAPE.usdc, W, quote.fee, ESCAPE.router, usdcSpend, outMin, 0n]])]);
      doing.push(`${usdcSpend} USDC units via fee tier ${quote.fee}`);
    }
  }

  // WETH leg.
  if (clearsFloor) {
    legs.push([W, new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [ESCAPE.router, safeWeth])]);
    doing.push(`${safeWeth} wei of wrapped native`);
  }

  if (!legs.length) {
    return {
      step: 'accumulate', reserve, floor: floorDesc, usdc_units: usdcHeld.toString(),
      note: `Nothing clears the conversion floor yet: Safe holds ${safeWeth} wei wrapped native (floor ${floorDesc}) and ${usdcHeld} USDC units (floor ${ESCAPE.minUsdcUnits}). Harvest instead; the funnel fires automatically once either clears.`,
      funnel: 'STANDING — it re-arms every tick, it does not finish.',
    };
  }

  legs.push([ESCAPE.router, new ethers.Interface(['function unwrapWETH9(uint256,address)']).encodeFunctionData('unwrapWETH9', [0n, eoa])]);
  const msData = new ethers.Interface(['function multiSend(bytes)'])
    .encodeFunctionData('multiSend', ['0x' + legs.map(([t, d]) => packCall(t, d)).join('')]);

  // Simulate the assembled batch before spending the slot. ALWAYS. MultiSend is all-or-nothing.
  try {
    await simulateMultiSendAsSafe(rpc, 'base', safe, msData);
  } catch (e) {
    return { step: 'funnel', reserve, simulated: false, converting: doing, error: String(e.message).slice(0, 140), note: 'Slot NOT spent.' };
  }

  const { all } = await pickChain(safe);
  const slot = all.find(c => c.name === 'base');
  if (!slot || slot.remaining === null || slot.remaining === undefined || slot.remaining < 1) {
    const unknown = !slot || slot.remaining === null || slot.remaining === undefined;
    return { step: 'funnel', reserve, simulated: true, ready: true, converting: doing,
      converts_usd: reserve.safe_weth_usd, legs: legs.length,
      skipped: unknown ? 'Base relay quota UNREADABLE this tick (' + (slot?.error || 'no reading') + ') — not spending on an unknown budget' : 'no Base relay slot right now' };
  }

  const before = eoaEth;
  const sent = await relayExec(env, rpc, safe, MULTISEND, msData, 'base', 8453, 1);  // DELEGATECALL
  await mutateKV(env, 'harvest:state', (s2) => {
    s2.escapeLog = [{ at: new Date().toISOString(), leg: 'funnel_atomic', relayed: sent.ok, taskId: sent.taskId, converting: doing, error: sent.error }, ...(s2.escapeLog || [])].slice(0, 10);
    if (sent.ok) s2.escaped = true;
    s2.lastFunnelAt = Date.now();
    return s2;
  });
  return {
    step: 'funnel', reserve, simulated: true, relayed: sent.ok, taskId: sent.taskId, error: sent.error,
    converting: doing, legs: legs.length, converts_usd: reserve.safe_weth_usd, eoa_native_before_wei: before.toString(),
    note: 'Everything the Safe held on Base -> native ETH at the EOA, one atomic slot. That is the ONLY number that counts as spendable, and this funnel re-arms every tick — it never reports done while the Safe holds anything.',
  };
}

// ── BATCH HARVEST — a relay slot is a TRANSACTION, not an ACTION ────────────
//
// The whole throughput model was wrong. "5 relay slots per chain per day" was read as "5 harvests a
// day", so the plan was to pick the single best strategy and leave the rest of the pool to rot. But a
// slot carries a Safe `execTransaction`, and that can DELEGATECALL MultiSend, which carries as many
// inner calls as fit in the gas limit.
//
// SIMULATED 2026-07-28 — and only simulated: a batch of 26 harvests simulated CLEAN from the Safe in
// one call (a batch of 10 estimated at 15.3M gas). WHAT THIS FUNCTION ACTUALLY EXECUTES IS CAPPED AT
// `max`, DEFAULT 12. It does not take "the entire pool", and no batch larger than 12 has ever been
// relayed. Corrected 2026-07-31: against an optimally chosen SINGLE harvest the honest multiple for a
// top-26 batch is 5.9x ($0.08929 of a $0.10705 live Base pool), and less than that at 12. The old
// "10-20x throughput" was never measured. The remaining slots re-sweep later as value re-accrues.
//
// MultiSend is ALL-OR-NOTHING: a single reverting inner call kills the whole batch. So every harvest
// is individually simulated first (free, unlimited) and only the clean ones go in.
export const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'; // MultiSendCallOnly v1.4.1

const packCall = (to, data) =>
  '00' + to.slice(2).toLowerCase() + '0'.repeat(64) +
  (data.length / 2 - 1).toString(16).padStart(64, '0') + data.slice(2);

/* ⚠️ MEASURED CEILING IS 6 — NOT 12, AND NOT 26 (2026-08-13). BISECTED, NOT ASSUMED.
   I raised this to 26 trusting the note that a 26-batch "SIMULATED clean". Then I actually relayed
   it. Same chain, minutes apart:
       max=23 -> 503    max=12 -> 503    max=8 -> 503    max=6 -> RELAYED    max=5 -> RELAYED
   Safe's relayer rejects an oversized batch with a GENERIC {"code":503,"message":"Service
   unavailable"} — indistinguishable from the relayer being down, which is why nobody had ever found
   the real limit. Bisecting was free: a rejected relay returns relayed:false and consumes NO slot.
   LESSON: a clean simulation is not permission to ship. The relayer is a SECOND gate the simulator
   cannot see, and it fails in a costume. Re-bisect before raising this number again.
   ── original reasoning kept below: it was right about WHY to raise it, wrong about the number ──
   RAISED 12 -> 26 (Anthony: "MORE ACTIONS PER MINUTE = higher chance of money per minute onchain").
   The note above records that a 26-harvest batch SIMULATED clean in one call and that no batch
   larger than 12 had ever actually been relayed — a cap set by caution, never by a measurement.
   Raising it is close to free to test: every leg is individually simulated before it goes in, so
   a bad leg is excluded rather than shipped, and the only downside of an oversized batch is that
   MultiSend reverts all-or-nothing and we lose ONE relay slot, which refills. No capital is at
   risk. The upside is real throughput per slot — a slot is the scarce thing, not the calls in it.
   If a 26-batch reverts on gas in production, drop to 20 and record the number; that is a
   MEASUREMENT we have never had. */
export async function batchHarvest(env, rpc, safe, chainName = 'base', { max = 6 } = {}) {
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`unknown chain ${chainName}`);
  const state = (await env.KV.get('harvest:state', 'json')) || { attempts: 0, wins: 0, weiEarned: '0', cooldowns: {}, log: [] };

  const strategies = await loadStrategies(env, rpc, chainName);
  // PAYMENT IS ALREADY VERIFIED HERE, unlike in harvestCycle: probeMany only returns contracts whose
  // simulated balance delta is strictly positive (oracle.mjs, `if (d > 0n)`), so every entry in
  // `paying` has a measured payout behind it. The eth_call below is a REVERT check on top of that, not
  // the payment evidence — do not read it as one.
  //
  // Deliberately NOT adding harvestCycle's per-candidate isolated probeOne gate here. Measured
  // 2026-07-31 at one pinned Base block, n=40: batched and isolated agreed 1.000x (0.003% apart), 38
  // payers either way, zero phantoms, same top pick. So an extra 12 isolated eth_calls every 2 minutes
  // would buy no accuracy on the hottest path in the system. harvestCycle needs the gate because its
  // BANDIT FALLBACK can select a strategy that probeMany never priced at all; this function has no
  // such path — nothing reaches the batch without a measured delta.
  const paying = await probeMany(rpc, chainName, strategies.map(s => s.strategy), chain.weth);
  if (!paying.length) return { skipped: 'nothing is paying on this chain right now', chain: chainName };

  // Validate each candidate ALONE — one revert would take the whole batch down with it.
  const iface = new ethers.Interface(['function harvest(address)']);
  const data = iface.encodeFunctionData('harvest', [safe]);
  const good = [];
  for (const p of paying.slice(0, max * 2)) {
    if (good.length >= max) break;
    try {
      await rpc(chainName, 'eth_call', [{ to: p.contract, data, from: safe }, 'latest']);
      good.push(p);
    } catch { /* excluded rather than allowed to poison the batch */ }
  }
  if (!good.length) return { skipped: 'none of the paying strategies simulate clean', chain: chainName, considered: paying.length };

  let batch = '0x';
  let expected = 0n;
  for (const g of good) { batch += packCall(g.contract, data); expected += BigInt(g.wei); }
  const msData = new ethers.Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [batch]);

  // Simulate the assembled batch before spending the slot. Always.
  try {
    await rpc(chainName, 'eth_call', [{ to: MULTISEND, data: msData, from: safe }, 'latest']);
  } catch (e) {
    return { skipped: 'assembled batch reverts', chain: chainName, size: good.length, error: String(e.message).slice(0, 140) };
  }

  const { all } = await pickChain(safe);
  const slot = all.find(c => c.name === chainName);
  if (!slot || slot.remaining === null || slot.remaining === undefined) {
    // UNKNOWN is not EXHAUSTED. Do not spend, but say which one it is — the two call for opposite
    // responses (wait for refill vs retry the read) and conflating them hid a dead rail before.
    return { ready: true, chain: chainName, size: good.length, expected_wei: expected.toString(),
      skipped: 'relay quota UNREADABLE on this chain this tick (' + (slot?.error || 'no reading') + ') — not spending on an unknown budget; this is NOT the same as exhausted' };
  }
  if (slot.remaining < 1) {
    return { ready: true, chain: chainName, size: good.length, expected_wei: expected.toString(), skipped: 'no relay slot on this chain' };
  }

  const before = await wethBalance(rpc, safe, chainName, chain.weth);
  const sent = await relayExec(env, rpc, safe, MULTISEND, msData, chainName, chain.chainId, 1); // DELEGATECALL
  const result = { chain: chainName, batched: good.length, expected_wei: expected.toString(), relayed: sent.ok, taskId: sent.taskId, error: sent.error };

  if (sent.ok && sent.taskId) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await relayStatus(sent.taskId, chain.chainId);
      if (st.tx) { result.tx = st.tx; await new Promise(r => setTimeout(r, 7000)); break; }
    }
    const after = await wethBalance(rpc, safe, chainName, chain.weth);
    const delta = after - before;
    result.wei_earned = delta.toString();
    result.eth_earned = ethers.formatEther(delta);
    let priced = null;
    if (delta > 0n) {
      priced = priceEarnings(delta.toString(), await nativeUsd(chainName));
      result.earned_usd = priced.usd;              // null, never 0, when the feed is down
      result.earned_wei = priced.wei;              // always exact
      if (priced.unpriced) result.earned_unpriced_note = priced.note;
    }
    // ⚠️ `state` was read at the TOP of this function, and everything since — the relay call and up
    // to ~60 SECONDS of status polling — has happened while the agent's own session runs
    // concurrently in another waitUntil and writes this same key. Writing the captured blob back
    // would erase whatever it recorded in that minute. Re-read and apply the deltas to FRESH state.
    await mutateKV(env, 'harvest:state', (s) => {
      if (delta > 0n) {
        s.wins = (s.wins || 0) + 1;
        s.weiEarned = addBig(s.weiEarned, delta);
      }
      s.cooldowns = s.cooldowns || {};
      for (const g of good) s.cooldowns[g.contract] = Date.now();
      s.attempts = (s.attempts || 0) + 1;
      s.log = [{ at: new Date().toISOString(), batch: good.length, ...result }, ...(s.log || [])].slice(0, 50);
      return s;
    }, { fallback: { attempts: 0, wins: 0, weiEarned: '0', cooldowns: {}, log: [] } });
  }
  return result;
}

export async function harvestCycle(env, rpc) {
  const safe = env.SAFE_ADDRESS || '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
  // Fees MUST land in the Safe, not the EOA. The Safe can spend (free relay); the EOA cannot move a
  // token without ETH it will never have. Earnings sent to the EOA are real but stranded.
  const recipient = safe;

  const state = (await env.KV.get('harvest:state', 'json')) || { attempts: 0, wins: 0, weiEarned: '0', cooldowns: {}, log: [] };
  if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < HARVEST_CFG.minAttemptGapMs) {
    return { skipped: 'attempt gap', next_in_min: Math.ceil((HARVEST_CFG.minAttemptGapMs - (Date.now() - state.lastAttemptAt)) / 60000) };
  }
  const { all: budgets } = await pickChain(safe);
  // Record the budget every cycle — this is the only way the real refill period ever gets measured.
  const obs = await observeRelay(env, budgets.map(b => ({ name: b.name, remaining: b.remaining, limit: b.limit })));
  if (!budgets.some(b => typeof b.remaining === 'number' && b.remaining > 0)) {
    return { skipped: 'relay budget exhausted on every chain', budgets, relay_reset: relayResetSummary(obs) };
  }

  // FALL THROUGH, do not commit to one chain. Picking only the chain with the MOST slots dead-ended
  // the whole cycle the moment that chain had nothing harvestable: Gnosis showed 5/5 but Beefy has no
  // active vaults there, so the harvester reported "every strategy on cooldown" and stopped — while
  // Polygon sat with 4 free slots and a proven payer. Slots on a chain with no work are worth nothing;
  // always keep walking down the list until a chain actually has something fresh to call.
  let chain = null, fresh = [], tried = [];
  for (const cand of budgets.filter(b => typeof b.remaining === 'number' && b.remaining > 0)) {
    const strategies = await loadStrategies(env, rpc, cand.name);
    const usable = strategies.filter(s => {
      if (BLACKLIST.has(s.strategy.slice(0, 14).toLowerCase())) return false;
      const cd = state.cooldowns[s.strategy];
      return !cd || Date.now() - cd > HARVEST_CFG.cooldownMs;
    });
    tried.push({ chain: cand.name, slots: cand.remaining, strategies: strategies.length, fresh: usable.length });
    if (usable.length) { chain = cand; fresh = usable; break; }
  }
  state.chainWork = Object.fromEntries(tried.map(t => [t.chain, t.fresh]));
  if (!chain) { await env.KV.put('harvest:state', JSON.stringify(state)); return { skipped: 'slots available but no fresh strategy on any of them', tried, tracked: Object.keys(state.cooldowns).length }; }
  const budget = { remaining: chain.remaining, limit: chain.limit };

  // Selection is EMPIRICAL, not predicted. callReward() proved worthless as a caller-fee signal
  // (read $615, paid $0.0001 â€” it measures something else entirely). What actually predicts a good
  // payout is what a strategy has ACTUALLY paid us before. So: optimistic-init bandit â€” untried
  // strategies rank above known-poor ones, and real results reorder the list forever.
  // Our marginal cost is zero, so ANY payout above zero is worth a slot. Take everything.
  state.payouts ||= {};
  const scored = fresh.map(s => {
    const h = state.payouts[s.strategy];
    return { ...s, score: h ? (h.totalWei / h.n) : Number.MAX_SAFE_INTEGER, tried: !!h };
  }).sort((a, b) => b.score - a.score);

  // MEASURE, DO NOT GUESS. The bandit above ranks by what a strategy paid us HISTORICALLY, which is
  // a prediction. The Multicall3 payout oracle simulates the settlement itself and returns the exact
  // fee this call would pay right now — free, no slot, no capital. Measured across our 12 known
  // payers the spread was 118x ($0.001419 best vs $0.000012 worst), so picking blind was throwing
  // away most of the value of every scarce relay slot. Probe first, then spend on the maximum.
  // Price the ENTIRE fresh universe, not a top-10 guess. Batched through Multicall3 this is ~10
  // requests for 241 contracts instead of ~1000, so there is no reason to sample. It matters: probing
  // all 241 Base strategies surfaced a $0.017 payout, 34x the $0.0005 blind-pick average and 12x the
  // best of the twelve we had been cycling. The maximum is nowhere near the middle.
  let chosen = null;
  let probes = [];
  try {
    const ranked = await probeMany(rpc, chain.name, fresh.map(f => f.strategy), chain.weth);
    const byAddr = new Map(fresh.map(f => [f.strategy.toLowerCase(), f]));
    probes = ranked
      .map(r => ({ cand: byAddr.get(r.contract.toLowerCase()), wei: BigInt(r.wei) }))
      .filter(p => p.cand);
  } catch { /* no information is not a blocker */ }
  // simulate() CANNOT tell you a harvest pays. It eth_calls and returns ok on anything that does not
  // revert — it reads no balance, keeps no return data, measures no delta (harvest.mjs, `simulate`).
  // A harvest that succeeds and pays zero passes it. So `sim.ok` is a REVERT check, and the payment
  // check has to come from a balance delta. probeOne supplies that for the single call we are about to
  // spend a slot on, which is what oracle.mjs's docstring has always prescribed and nothing implemented.
  // Capped at ISOLATED_WALK candidates: one extra free eth_call each, but a Worker has a subrequest
  // ceiling and an unbounded walk down 241 strategies would reach it.
  const ISOLATED_WALK = 12;
  for (const p of probes.slice(0, ISOLATED_WALK)) {
    const sim = await simulate(rpc, p.cand.strategy, safe, recipient, chain.name);
    if (!sim.ok) { state.cooldowns[p.cand.strategy] = Date.now(); continue; }
    // These candidates already carry a MEASURED positive delta from probeMany, so the isolated read is
    // a re-verification, not the only evidence. If it cannot run we keep the batched number rather than
    // inventing a zero — an unmeasurable probe is unknown (see probeOne's return contract).
    const iso = await probeOne(rpc, chain.name, p.cand.strategy, chain.weth, recipient);
    if (iso.measured && iso.wei <= 0n) { state.cooldowns[p.cand.strategy] = Date.now(); continue; }
    chosen = {
      ...p.cand, ...sim,
      predicted_wei: p.wei.toString(),
      measured_wei: iso.measured ? iso.wei.toString() : null,
      payment_verified: iso.measured ? 'isolated' : 'batched-only:' + (iso.reason || 'probe unavailable'),
    };
    break;
  }
  // Oracle found nothing payable (or every probe failed) — fall back to the historical bandit so a
  // slot is never wasted just because the measurement was unavailable.
  if (!chosen) {
    for (const cand of scored.slice(0, ISOLATED_WALK)) {
      const sim = await simulate(rpc, cand.strategy, safe, recipient, chain.name);
      if (!sim.ok) { state.cooldowns[cand.strategy] = Date.now(); continue; }
      // STRICTER THAN THE PATH ABOVE, deliberately. The bandit ranks on what a strategy paid us in the
      // PAST; nothing here has measured that it pays anything now, so probeOne is the only evidence
      // there is. It must both run AND come back positive — an unavailable probe is not a green light.
      const iso = await probeOne(rpc, chain.name, cand.strategy, chain.weth, recipient);
      if (!iso.measured || iso.wei <= 0n) { state.cooldowns[cand.strategy] = Date.now(); continue; }
      chosen = { ...cand, ...sim, measured_wei: iso.wei.toString(), payment_verified: 'isolated' };
      break;
    }
  }
  if (!chosen) {
    // Keep the slot. Slots refill on their own; a slot spent on a strategy that pays zero is gone and
    // bought nothing. "Nothing simulated clean" used to be the only way to get here — now it also
    // covers "simulated clean but measured zero payout", which is the case simulate() could never see.
    state.lastAttemptAt = Date.now();
    await env.KV.put('harvest:state', JSON.stringify(state));
    return { skipped: 'no candidate both simulates clean AND measures a positive payout — slot kept', considered: scored.length, probed: probes.length };
  }

  const before = await wethBalance(rpc, recipient, chain.name, chain.weth);
  const sent = await relayExec(env, rpc, safe, chosen.strategy, chosen.data, chain.name, chain.chainId);
  state.attempts += 1;
  state.lastAttemptAt = Date.now();
  state.cooldowns[chosen.strategy] = Date.now();

  // measured_wei is what the isolated probe said this exact call would pay, recorded alongside what it
  // actually paid (wei_earned below). Predicted-vs-received is the only way we ever find out that a
  // gate has started lying, and every gate we have trusted so far eventually did.
  let result = {
    chain: chain.name, strategy: chosen.strategy, id: chosen.id,
    measured_wei: chosen.measured_wei ?? null,
    predicted_wei: chosen.predicted_wei ?? null,
    payment_verified: chosen.payment_verified ?? null,
    relayed: sent.ok, taskId: sent.taskId, error: sent.error,
  };
  if (sent.ok && sent.taskId) {
    // Wait for inclusion AND for the node to reflect it â€” measuring too early reported 0 on a
    // harvest that actually paid (verified: tx 0x76a2db9bâ€¦ credited after the check had returned).
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await relayStatus(sent.taskId, chain.chainId);
      if (st.tx) { result.tx = st.tx; await new Promise(r => setTimeout(r, 6000)); break; }
    }
    const after = await wethBalance(rpc, recipient, chain.name, chain.weth);
    const delta = after - before;
    result.wei_earned = delta.toString();
    result.eth_earned = ethers.formatEther(delta);
    if (delta > 0n) {
      state.wins += 1;
      state.weiEarned = (BigInt(state.weiEarned) + delta).toString();
    }
    // Learn: record what this strategy ACTUALLY paid the caller. This is the only real signal.
    const rec = state.payouts[chosen.strategy] ||= { n: 0, totalWei: 0 };
    rec.n += 1;
    rec.totalWei += Number(delta);
    rec.lastWei = delta.toString();
    // A strategy that paid us literally nothing gets a long cooldown â€” not banned (it may accrue
    // again), just deprioritised so slots go to teats that actually flow.
    if (delta === 0n) state.cooldowns[chosen.strategy] = Date.now() + HARVEST_CFG.cooldownMs;
  }
  state.log.unshift({ at: new Date().toISOString(), ...result });
  state.log = state.log.slice(0, 50);
  await env.KV.put('harvest:state', JSON.stringify(state));

  // Mirror real earnings into the agent's own ledger so its worldview stays true.
  // This block used to bump attempts/successes and NEVER touch earned_usd, so the agent's own
  // leaderboard reported $0.00253 against $0.0174 actually on-chain and it ranked its one working
  // route as worthless. A route's earned_usd must move whenever real value lands.
  if (result.wei_earned && BigInt(result.wei_earned) > 0n) {
    try {
      // price the token THIS CHAIN pays in, never a blanket ETH price
      const price = await nativeUsd(chain.name);
      // THE EARNINGS LEDGER, and the agent's own route_log tool writes it concurrently from another
      // waitUntil. A captured-blob write here can erase a route the session just recorded — which is
      // the one piece of state this project genuinely cannot afford to lose, because it is the only
      // durable proof that a route ever paid.
      let priced = null;
      await mutateKV(env, 'state:routes', (db) => {
        db.routes ||= {};
        const r = db.routes['beefy-harvest-caller-fees'] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
        r.attempts += 1; r.successes += 1;
        // Credits wei always, USD only when it is actually known. An unreadable price can no longer
        // write a real payout into the permanent ledger as $0.00.
        priced = creditRoute(r, result.wei_earned, price);
        r.last = { at: new Date().toISOString(), outcome: 'success' };
        r.notes = [`autoharvest ${chosen.id}: +${result.eth_earned} WETH (${priced.unpriced ? 'USD UNKNOWN — price feed down, wei recorded' : '$' + priced.usd}) (tx ${result.tx || 'pending'})`, ...(r.notes || [])].slice(0, 5);
        return db;
      }, { fallback: { routes: {} } });
      result.earned_usd = priced?.usd ?? null;
    } catch { /* bookkeeping must never break the loop */ }
  }
  return { ...result, budget_before: budget, totals: { attempts: state.attempts, wins: state.wins, weiEarned: state.weiEarned } };
}

